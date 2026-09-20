let appState = {
    isLoggedIn: false, user: null,
    sheetTitle: "Happy Miles", sheetData: {}, sheetFormats: {}, activeTab: null,
    filteredCombined: [], queue: [], imageQueue: [],
    onDuty: false, onBreak: false, startOdo: 0, shiftStartTime: null, breakStartTime: null, totalBreakDurationMs: 0,
    liveTimerInterval: null, backgroundSyncInterval: null, pendingOdoType: null, map: null, gpsWatchId: null,
    userMarker: null, routePolyline: null, routeCoords: [], deferredPrompt: null,
    currentImageBase64: null, currentReceiptBase64: null
};

let currentZoom = 13; // Base font size for table

document.addEventListener("DOMContentLoaded", () => { initApp(); });

function initApp() {
    registerServiceWorker(); setupPWAInstallPrompt(); loadLocalStorageState(); checkAuth();
    window.addEventListener("online", updateNetworkStatus);
    window.addEventListener("offline", updateNetworkStatus);
    updateNetworkStatus();
}

function registerServiceWorker() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(e => console.log("SW error", e));
}

function setupPWAInstallPrompt() {
    window.addEventListener("beforeinstallprompt", (e) => {
        e.preventDefault(); appState.deferredPrompt = e;
        const btn = document.getElementById("pwaInstallBtn");
        if (btn) btn.style.display = "inline-flex";
    });
}

function loadLocalStorageState() {
    try { appState.queue = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.QUEUE)) || []; } catch(e){}
    try { appState.imageQueue = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.IMAGE_QUEUE)) || []; } catch(e){}
    try { appState.sheetFormats = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.FORMAT_CACHE)) || {}; } catch(e){}
    
    const savedDuty = localStorage.getItem(CONFIG.STORAGE_KEYS.DUTY_STATE);
    if (savedDuty) {
        try {
            const d = JSON.parse(savedDuty);
            appState.onDuty = d.onDuty || false; appState.startOdo = d.startOdo || 0;
            appState.shiftStartTime = d.shiftStartTime ? new Date(d.shiftStartTime) : null;
            appState.onBreak = d.onBreak || false; appState.totalBreakDurationMs = d.totalBreakDurationMs || 0;
        } catch(e){}
    }
    updateQueueBadge();
}

function saveDutyState() {
    localStorage.setItem(CONFIG.STORAGE_KEYS.DUTY_STATE, JSON.stringify({
        onDuty: appState.onDuty, startOdo: appState.startOdo,
        shiftStartTime: appState.shiftStartTime ? appState.shiftStartTime.toISOString() : null,
        onBreak: appState.onBreak, totalBreakDurationMs: appState.totalBreakDurationMs
    }));
}

function checkAuth() {
    const t = localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH);
    const uStr = localStorage.getItem(CONFIG.STORAGE_KEYS.USER);
    if (t && uStr) {
        appState.isLoggedIn = true; appState.user = JSON.parse(uStr);
        document.getElementById("loginOverlay").style.display = "none";
        document.getElementById("dashboardPanel").style.display = "flex";
        restoreDutyUI();
        
        // 3-hour Auto Refresh
        if(appState.backgroundSyncInterval) clearInterval(appState.backgroundSyncInterval);
        appState.backgroundSyncInterval = setInterval(() => fetchSheetData(true), 10800000);
        
        document.getElementById("dutyAccordion").addEventListener("toggle", (e) => {
            if(e.target.open && !appState.map) setTimeout(initMap, 100);
        });

        // Load cached instantly, then fetch fresh if online
        const c = localStorage.getItem(CONFIG.STORAGE_KEYS.DATA_CACHE);
        if(c) {
            try { 
                const parsed = JSON.parse(c);
                appState.sheetTitle = parsed.title; appState.sheetData = parsed.sheets;
                buildUIFromSheetData(); 
            } catch(e){}
        }
        if(navigator.onLine) fetchSheetData(true);
    } else {
        appState.isLoggedIn = false;
        document.getElementById("loginOverlay").style.display = "flex";
        document.getElementById("dashboardPanel").style.display = "none";
    }
}

function handleLogin(e) {
    e.preventDefault();
    const u = document.getElementById("username").value.trim();
    const p = document.getElementById("password").value.trim();
    if (CONFIG.USERS[u] && CONFIG.USERS[u].password === p) {
        document.getElementById("loginError").style.display = "none";
        localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH, "TOKEN_" + Date.now());
        localStorage.setItem(CONFIG.STORAGE_KEYS.USER, JSON.stringify({ username: u, spreadsheetId: CONFIG.USERS[u].spreadsheetId }));
        
        // Hard wipe cache on fresh login
        localStorage.removeItem(CONFIG.STORAGE_KEYS.DATA_CACHE);
        localStorage.removeItem(CONFIG.STORAGE_KEYS.FORMAT_CACHE);
        appState.sheetData = {}; appState.sheetFormats = {}; appState.sheetTitle = "Happy Miles";
        checkAuth();
    } else {
        document.getElementById("loginError").style.display = "block";
    }
}

function logout() {
    localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.USER);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.DATA_CACHE); 
    localStorage.removeItem(CONFIG.STORAGE_KEYS.FORMAT_CACHE); 
    stopGpsTracking();
    if (appState.liveTimerInterval) clearInterval(appState.liveTimerInterval);
    if (appState.backgroundSyncInterval) clearInterval(appState.backgroundSyncInterval);
    checkAuth();
}

function updateNetworkStatus() {
    const dot = document.getElementById("statusDot");
    if (navigator.onLine) {
        dot.classList.remove("error");
        if (appState.isLoggedIn) { processQueue(); processImageQueue(); }
    } else {
        dot.classList.add("error");
        showToast("Offline Mode");
    }
}

function fetchSheetData(force = false) {
    if (!navigator.onLine) return;
    const sheetArea = document.getElementById("sheetArea");
    if(force && Object.keys(appState.sheetData).length === 0) sheetArea.innerHTML = `<div class="loading-screen"><div class="spinner"></div><div>Fetching live ledger...</div></div>`;

    // STEP 1: Fetch raw text instantly
    fetch(`${CONFIG.APPS_SCRIPT_URL}?action=getData&sheetId=${appState.user.spreadsheetId}`)
        .then(res => res.json())
        .then(data => {
            if (data.status === "success") {
                appState.sheetTitle = data.title || "Happy Miles";
                appState.sheetData = data.sheets;
                localStorage.setItem(CONFIG.STORAGE_KEYS.DATA_CACHE, JSON.stringify({ title: data.title, sheets: data.sheets }));
                buildUIFromSheetData(); 
                
                // STEP 2: Silently fetch formatting in the background
                fetchSheetFormatting();
            }
        }).catch(err => console.log("Data Fetch failed", err));
}

function fetchSheetFormatting() {
    fetch(`${CONFIG.APPS_SCRIPT_URL}?action=getFormat&sheetId=${appState.user.spreadsheetId}`)
        .then(res => res.json())
        .then(data => {
            if (data.status === "success") {
                appState.sheetFormats = data.formats;
                localStorage.setItem(CONFIG.STORAGE_KEYS.FORMAT_CACHE, JSON.stringify(data.formats));
                buildUIFromSheetData(); 
            }
        }).catch(err => console.log("Format Fetch failed", err));
}

function buildUIFromSheetData() {
    document.getElementById("pageTitle").innerText = appState.sheetTitle;
    const tabBar = document.getElementById("tabBar");
    tabBar.innerHTML = "";
    const sheetNames = Object.keys(appState.sheetData);
    if (sheetNames.length === 0) { document.getElementById("sheetArea").innerHTML = `<div class="loading-screen">No data.</div>`; return; }

    sheetNames.forEach((n, idx) => {
        const btn = document.createElement("div");
        btn.className = `tab-item ${n === appState.activeTab || (!appState.activeTab && idx === 0) ? 'active' : ''}`;
        btn.innerText = n;
        btn.onclick = () => switchTab(n);
        tabBar.appendChild(btn);
    });

    if (!appState.activeTab || !appState.sheetData[appState.activeTab]) appState.activeTab = sheetNames[0];
    switchTab(appState.activeTab);
}

function switchTab(name) {
    appState.activeTab = name;
    document.querySelectorAll(".tab-item").forEach(t => t.classList.toggle("active", t.innerText === name));
    document.getElementById("searchBox").value = "";
    populateFilterDropdown(); applyFilterAndSearch();
}

function populateFilterDropdown() {
    const fb = document.getElementById("filterBox");
    fb.innerHTML = `<option value="all">All Rows</option>`;
}

function handleSearchInput() { applyFilterAndSearch(); }
function handleFilterChange() { applyFilterAndSearch(); }

function applyFilterAndSearch() {
    const rawRows = appState.sheetData[appState.activeTab] || [];
    const fmt = appState.sheetFormats[appState.activeTab] || null;
    if (rawRows.length === 0) { renderTable([]); return; }

    const term = document.getElementById("searchBox").value.toLowerCase().trim();
    
    // Determine Frozen Rows based on Google Sheets data (or fallback to regex)
    let frozenRowCount = fmt && fmt.frozenRows ? fmt.frozenRows : 1;
    if (!fmt) {
        for(let i = 0; i < Math.min(10, rawRows.length); i++) {
            if (/^\d{1,2}-[a-zA-Z]{3}(?:-\d{2,4})?$/.test(String(rawRows[i][0]).trim())) { frozenRowCount = i; break; }
        }
        if (frozenRowCount === 0) frozenRowCount = 1;
    }

    let headers = rawRows.slice(0, frozenRowCount).map((r, i) => ({ data: r, origIndex: i }));
    let body = rawRows.slice(frozenRowCount).map((r, i) => ({ data: r, origIndex: i + frozenRowCount }));

    if (term !== "") body = body.filter(r => r.data.some(c => String(c).toLowerCase().includes(term)));
    
    appState.filteredCombined = headers.concat(body);
    document.getElementById("rowCount").innerText = `${body.length} rows`;
    renderTable(headers, body, fmt);
    calculateSubtotals(headers[headers.length-1]?.data || rawRows[0], body);
}

function renderTable(headers, bodyRows, fmt) {
    const sheetArea = document.getElementById("sheetArea");
    if (headers.length === 0) { sheetArea.innerHTML = `<div class="loading-screen">Empty</div>`; return; }

    const totalCols = headers[0].data.length;
    let html = `<table class="sheet-table">`;
    
    // Pre-calculate merged blocks to map HTML rowspans/colspans
    let skipCell = {}; let spanAttrs = {};
    if (fmt && fmt.merges) {
        fmt.merges.forEach(m => {
            spanAttrs[`${m.r1}_${m.c1}`] = ` rowspan="${m.r2 - m.r1 + 1}" colspan="${m.c2 - m.c1 + 1}" `;
            for (let r = m.r1; r <= m.r2; r++) {
                for (let c = m.c1; c <= m.c2; c++) {
                    if (r !== m.r1 || c !== m.c1) skipCell[`${r}_${c}`] = true;
                }
            }
        });
    }

    const renderRow = (rowObj, isHeader) => {
        let rowHtml = `<tr>`;
        let origR = rowObj.origIndex;
        
        for (let c = 0; c < totalCols; c++) {
            if (skipCell[`${origR}_${c}`]) continue; // Cell hidden inside a merge
            
            let val = rowObj.data[c];
            let spans = spanAttrs[`${origR}_${c}`] || "";
            
            // Build pixel-perfect CSS based on Google formats
            let style = ""; let classes = [];
            
            if (fmt) {
                if (fmt.bg && fmt.bg[origR] && fmt.bg[origR][c] && fmt.bg[origR][c] !== "#ffffff") style += `background-color: ${fmt.bg[origR][c]} !important;`;
                if (fmt.fc && fmt.fc[origR] && fmt.fc[origR][c]) style += `color: ${fmt.fc[origR][c]};`;
                if (fmt.fw && fmt.fw[origR] && fmt.fw[origR][c] === "bold") style += `font-weight: 900;`;
                if (fmt.ha && fmt.ha[origR] && fmt.ha[origR][c]) style += `text-align: ${fmt.ha[origR][c]};`;
                if (fmt.va && fmt.va[origR] && fmt.va[origR][c]) style += `vertical-align: ${fmt.va[origR][c]};`;
                if (fmt.frozenColumns && c < fmt.frozenColumns) classes.push("sticky-col");
            }

            let displayVal = val;
            let hasDropdown = fmt && fmt.dropdowns && fmt.dropdowns[origR] && fmt.dropdowns[origR][c];
            
            if (hasDropdown && hasDropdown.length > 0) {
                let opts = hasDropdown;
                displayVal = `<select onchange="updateCellValue('${appState.activeTab}', ${origR}, ${c}, this.value)" style="width:100%; border:none; background:transparent; font-family:inherit; font-size:inherit; font-weight:inherit; color:inherit;">`;
                displayVal += `<option value="${val}" selected>${val}</option>`;
                opts.forEach(opt => {
                    if(String(opt) !== String(val)) displayVal += `<option value="${opt}">${opt}</option>`;
                });
                displayVal += `</select>`;
            } else if (typeof displayVal === "string" && displayVal.startsWith("http")) {
                displayVal = `<a href="${displayVal}" target="_blank">Proof</a>`;
            } else {
                let valStr = String(val).trim();
                let num = parseFloat(valStr.replace(/,/g, ''));
                if (!isNaN(num) && valStr !== "" && !/^[a-zA-Z]/.test(valStr) && !/^\d{1,2}-[a-zA-Z]{3}(?:-\d{2,4})?$/.test(valStr)) {
                    let rounded = Math.round(num);
                    if (rounded === 0) displayVal = "";
                    else displayVal = rounded.toLocaleString('en-IN');
                }
            }

            let cellTag = isHeader ? "th" : "td";
            let classStr = classes.length > 0 ? `class="${classes.join(' ')}"` : "";
            rowHtml += `<${cellTag} ${spans} ${classStr} style="${style}">${displayVal}</${cellTag}>`;
        }
        rowHtml += `</tr>`;
        return rowHtml;
    };

    html += `<thead>`;
    headers.forEach(h => html += renderRow(h, true));
    html += `</thead><tbody>`;

    if (bodyRows.length === 0) {
        html += `<tr><td colspan="${totalCols}" style="text-align:center;">No records found</td></tr>`;
    } else {
        bodyRows.forEach(r => html += renderRow(r, false));
    }
    
    html += `</tbody></table>`;
    sheetArea.innerHTML = html;
    changeZoom(0); // Apply current zoom state
}

function calculateSubtotals(headerRow, bodyRows) {
    const bar = document.getElementById("subtotalBar");
    bar.innerHTML = "";
    if (bodyRows.length === 0) return;

    let statHtml = `<div class="stat-group">`;
    headerRow.forEach((h, colIdx) => {
        let numericVals = bodyRows.map(r => parseFloat(String(r.data[colIdx]).replace(/[^0-9.-]+/g, ""))).filter(v => !isNaN(v));
        if (numericVals.length > 0 && numericVals.length >= bodyRows.length * 0.4 && String(h).trim() !== "") {
            let sum = Math.round(numericVals.reduce((a, b) => a + b, 0));
            statHtml += `<span><strong>${h}:</strong> <span class="${sum >= 0 ? 'val-pos' : 'val-neg'}">${sum.toLocaleString('en-IN')}</span></span>`;
        }
    });
    statHtml += `</div>`;
    bar.innerHTML = statHtml;
}

function changeZoom(step) {
    currentZoom += step;
    if (currentZoom < 9) currentZoom = 9;   
    if (currentZoom > 24) currentZoom = 24; 
    const table = document.querySelector(".sheet-table");
    if (table) table.style.fontSize = currentZoom + "px";
}

function updateCellValue(sheetName, row, col, value) {
    if (!navigator.onLine) {
        alert("Internet required to interact with live formulas.");
        fetchSheetData(false); // Reverts visual change if offline
        return;
    }
    
    document.getElementById("syncOverlay").style.display = "flex";
    
    const payload = { action: "updateCell", spreadsheetId: appState.user.spreadsheetId, sheetName: sheetName, row: row, col: col, value: value };
    
    fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload)
    }).then(res => res.json()).then(data => {
        if (data.status === "success") {
            setTimeout(() => { fetchSheetData(true); document.getElementById("syncOverlay").style.display = "none"; }, 1500);
        } else {
            alert("Failed to update Google Sheet."); document.getElementById("syncOverlay").style.display = "none";
        }
    }).catch(e => {
        alert("Network error."); document.getElementById("syncOverlay").style.display = "none";
    });
}

function restoreDutyUI() {
    const toggle = document.getElementById("dutyToggle");
    const badge = document.getElementById("dutyStatusBadge");
    const metrics = document.getElementById("dutyMetrics");
    const breakBtn = document.getElementById("breakBtn");

    toggle.checked = appState.onDuty;
    if (appState.onDuty) {
        badge.innerText = appState.onBreak ? "ON BREAK" : "ON DUTY";
        badge.className = appState.onBreak ? "status-badge on-break" : "status-badge on-duty";
        metrics.style.display = "grid"; breakBtn.style.display = "inline-flex";
        breakBtn.innerText = appState.onBreak ? "▶ Resume" : "🍱 Break";
        document.getElementById("lblStartOdo").innerText = appState.startOdo;
        startLiveShiftTimer(); startGpsTracking();
    } else {
        badge.innerText = "OFF DUTY"; badge.className = "status-badge off-duty";
        metrics.style.display = "none"; breakBtn.style.display = "none";
        if (appState.liveTimerInterval) clearInterval(appState.liveTimerInterval);
        stopGpsTracking();
    }
}

function toggleDuty(checked) {
    if (checked) { appState.pendingOdoType = "START"; document.getElementById("checklistModal").style.display = "flex"; } 
    else { appState.pendingOdoType = "END"; triggerOdometerCamera(); }
}

function confirmChecklist() { document.getElementById("checklistModal").style.display = "none"; triggerOdometerCamera(); }
function triggerOdometerCamera() { document.getElementById("odometerInput").click(); }
function cancelOdometerCapture() {
    document.getElementById("checklistModal").style.display = "none"; document.getElementById("ocrModal").style.display = "none";
    document.getElementById("dutyToggle").checked = appState.onDuty;
}

function handleOdometerCapture(event) {
    const file = event.target.files[0]; if (!file) return;
    document.getElementById("ocrModal").style.display = "flex"; document.getElementById("ocrProcessingState").style.display = "block";
    document.getElementById("ocrVerifySection").style.display = "none";

    Tesseract.recognize(file, 'eng').then(({ data: { text } }) => {
        const matches = text.match(/\b\d{4,6}\b/g);
        document.getElementById("ocrProcessingState").style.display = "none"; document.getElementById("ocrVerifySection").style.display = "block";
        document.getElementById("odometerInputValue").value = matches ? matches[0] : "";
    }).catch(() => {
        document.getElementById("ocrProcessingState").style.display = "none"; document.getElementById("ocrVerifySection").style.display = "block";
        showToast("OCR warning. Enter manually.");
    });

    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image(); img.onload = () => {
            const canvas = document.createElement("canvas"); const ctx = canvas.getContext("2d");
            const scaleSize = 800 / img.width; canvas.width = 800; canvas.height = img.height * scaleSize;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            appState.currentImageBase64 = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
        }; img.src = e.target.result;
    }; reader.readAsDataURL(file);
}

function submitOdometerData() {
    const val = parseFloat(document.getElementById("odometerInputValue").value);
    if (isNaN(val) || val <= 0) return alert("Invalid reading.");
    document.getElementById("ocrModal").style.display = "none";

    let proofText = "No Image";
    if (appState.currentImageBase64) {
        proofText = `Odo_${appState.user.username}_${Date.now()}.jpg`;
        appState.imageQueue.push({ filename: proofText, imageBase64: appState.currentImageBase64 });
        localStorage.setItem(CONFIG.STORAGE_KEYS.IMAGE_QUEUE, JSON.stringify(appState.imageQueue));
    }

    const payload = { user: appState.user.username, timestamp: new Date().toISOString(), imageProof: proofText };
    if (appState.pendingOdoType === "START") {
        appState.onDuty = true; appState.startOdo = val; appState.shiftStartTime = new Date(); appState.onBreak = false;
        addToQueue({ ...payload, type: "DUTY_START", odometer: val });
        checkMaintenanceAlert(val);
    } else {
        const dur = Math.round((new Date() - appState.shiftStartTime - appState.totalBreakDurationMs) / 60000);
        appState.onDuty = false;
        addToQueue({ ...payload, type: "DUTY_END", startOdo: appState.startOdo, endOdo: val, distanceKm: val - appState.startOdo, durationMinutes: dur });
    }
    saveDutyState(); restoreDutyUI(); processImageQueue(); appState.currentImageBase64 = null;
}

function toggleBreak() {
    appState.onBreak = !appState.onBreak;
    if (appState.onBreak) appState.breakStartTime = new Date();
    else if (appState.breakStartTime) { appState.totalBreakDurationMs += (new Date() - appState.breakStartTime); appState.breakStartTime = null; }
    saveDutyState(); restoreDutyUI();
}

function startLiveShiftTimer() {
    if (appState.liveTimerInterval) clearInterval(appState.liveTimerInterval);
    appState.liveTimerInterval = setInterval(() => {
        if (!appState.shiftStartTime) return;
        let el = new Date() - appState.shiftStartTime - appState.totalBreakDurationMs;
        if (appState.onBreak && appState.breakStartTime) el -= (new Date() - appState.breakStartTime);
        if (el < 0) el = 0;
        document.getElementById("lblLiveTime").innerText = `${String(Math.floor(el/3600000)).padStart(2,'0')}h ${String(Math.floor((el%3600000)/60000)).padStart(2,'0')}m`;
    }, 1000);
}

function openExpenseModal() { document.getElementById("expenseModal").style.display = "flex"; }
function closeExpenseModal() { document.getElementById("expenseModal").style.display = "none"; appState.currentReceiptBase64 = null; document.querySelector("#expenseModal form").reset(); }

function handleReceiptCapture(e) {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const img = new Image(); img.onload = () => {
            const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = img.height * (800 / img.width);
            canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
            appState.currentReceiptBase64 = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
        }; img.src = ev.target.result;
    }; reader.readAsDataURL(f);
}

function handleExpenseSubmit(e) {
    e.preventDefault();
    let proof = "No Image";
    if (appState.currentReceiptBase64) {
        proof = `Exp_${document.getElementById("expType").value}_${Date.now()}.jpg`;
        appState.imageQueue.push({ filename: proof, imageBase64: appState.currentReceiptBase64 });
        localStorage.setItem(CONFIG.STORAGE_KEYS.IMAGE_QUEUE, JSON.stringify(appState.imageQueue));
    }
    addToQueue({ type: "EXPENSE", user: appState.user.username, category: document.getElementById("expType").value, quantity: parseFloat(document.getElementById("expQty").value), cost: parseFloat(document.getElementById("expCost").value), odometer: parseFloat(document.getElementById("expOdo").value), timestamp: new Date().toISOString(), imageProof: proof });
    closeExpenseModal(); showToast("Expense logged."); processImageQueue();
}

function addToQueue(item) {
    appState.queue.push(item); localStorage.setItem(CONFIG.STORAGE_KEYS.QUEUE, JSON.stringify(appState.queue));
    updateQueueBadge(); processQueue();
}

function updateQueueBadge() {
    const b = document.getElementById("queueBadge"); const t = appState.queue.length + appState.imageQueue.length;
    b.innerText = `${t} queued`; b.className = `queue-badge ${t > 0 ? 'has-items' : ''}`;
}

function processQueue() {
    if (!navigator.onLine || appState.queue.length === 0) return;
    const item = appState.queue[0]; item.spreadsheetId = appState.user.spreadsheetId;
    fetch(CONFIG.APPS_SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(item) })
    .then(res => res.json()).then(data => {
        if (data.status === "success") { appState.queue.shift(); localStorage.setItem(CONFIG.STORAGE_KEYS.QUEUE, JSON.stringify(appState.queue)); updateQueueBadge(); if (appState.queue.length > 0) processQueue(); else fetchSheetData(true); }
    }).catch(e => console.log(e));
}

function processImageQueue() {
    if (!navigator.onLine || appState.imageQueue.length === 0) return;
    fetch(CONFIG.TERMUX_SERVER_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(appState.imageQueue[0]) })
    .then(res => { if (res.ok) { appState.imageQueue.shift(); localStorage.setItem(CONFIG.STORAGE_KEYS.IMAGE_QUEUE, JSON.stringify(appState.imageQueue)); updateQueueBadge(); if (appState.imageQueue.length > 0) processImageQueue(); } }).catch(e => console.log(e));
}

function initMap() {
    if (appState.map) { setTimeout(() => appState.map.invalidateSize(), 200); return; }
    appState.map = L.map('map').setView([CONFIG.MAP.DEFAULT_LAT, CONFIG.MAP.DEFAULT_LNG], CONFIG.MAP.ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(appState.map);
    appState.routePolyline = L.polyline([], { color: '#188038', weight: 4 }).addTo(appState.map);
}
function startGpsTracking() { if(navigator.geolocation) appState.gpsWatchId = navigator.geolocation.watchPosition(pos => { const ll = [pos.coords.latitude, pos.coords.longitude]; appState.routeCoords.push(ll); if(appState.map) { if(!appState.userMarker) appState.userMarker = L.marker(ll).addTo(appState.map); else appState.userMarker.setLatLng(ll); appState.routePolyline.setLatLngs(appState.routeCoords); appState.map.panTo(ll); } }, null, { enableHighAccuracy:true }); }
function stopGpsTracking() { if(appState.gpsWatchId) navigator.geolocation.clearWatch(appState.gpsWatchId); }

function checkMaintenanceAlert(o) {
    let a=[]; if(o%CONFIG.MAINTENANCE_THRESHOLDS.oilChange<300) a.push("Oil"); if(o%CONFIG.MAINTENANCE_THRESHOLDS.tireRotation<300) a.push("Tires");
    const d=document.getElementById("maintenanceAlertCard");
    if(a.length>0) { d.style.display="block"; d.innerHTML=`⚠️ Service Due: <strong>${a.join(", ")}</strong>`; } else d.style.display="none";
}
function exportShiftCSV() { let csv="data:text/csv;charset=utf-8,"+appState.filteredCombined.map(e=>e.data.map(c=>`"${c}"`).join(",")).join("\n"); let l=document.createElement("a"); l.href=encodeURI(csv); l.download=`Export_${Date.now()}.csv`; l.click(); }
function showDiagnostics() { alert(`Online: ${navigator.onLine}\nData Queue: ${appState.queue.length}\nImg Queue: ${appState.imageQueue.length}`); }
function showToast(m) { const t=document.getElementById("toast"); t.innerText=m; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"), 3000); }
