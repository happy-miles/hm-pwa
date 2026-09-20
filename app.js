let appState = {
    isLoggedIn: false,
    user: null,
    sheetData: {},
    activeTab: null,
    filteredRows: [],
    queue: [],
    imageQueue: [],
    onDuty: false,
    onBreak: false,
    startOdo: 0,
    shiftStartTime: null,
    breakStartTime: null,
    totalBreakDurationMs: 0,
    liveTimerInterval: null,
    pendingOdoType: null,
    map: null,
    gpsWatchId: null,
    userMarker: null,
    routePolyline: null,
    routeCoords: [],
    deferredPrompt: null,
    currentImageBase64: null,
    currentReceiptBase64: null
};

document.addEventListener("DOMContentLoaded", () => {
    initApp();
});

function initApp() {
    registerServiceWorker();
    setupPWAInstallPrompt();
    loadLocalStorageState();
    checkAuth();

    window.addEventListener("online", updateNetworkStatus);
    window.addEventListener("offline", updateNetworkStatus);
    updateNetworkStatus();
}

function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js")
            .then(() => console.log("Service Worker registered."))
            .catch(err => console.error("SW registration failed:", err));
    }
}

function setupPWAInstallPrompt() {
    window.addEventListener("beforeinstallprompt", (e) => {
        e.preventDefault();
        appState.deferredPrompt = e;
        const btn = document.getElementById("pwaInstallBtn");
        if (btn) btn.style.display = "inline-flex";
    });
}

function installPWA() {
    if (appState.deferredPrompt) {
        appState.deferredPrompt.prompt();
        appState.deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === "accepted") {
                document.getElementById("pwaInstallBtn").style.display = "none";
            }
            appState.deferredPrompt = null;
        });
    }
}

function loadLocalStorageState() {
    const savedTheme = localStorage.getItem(CONFIG.STORAGE_KEYS.THEME);
    if (savedTheme === "dark") document.documentElement.classList.add("dark");

    const savedQueue = localStorage.getItem(CONFIG.STORAGE_KEYS.QUEUE);
    if (savedQueue) try { appState.queue = JSON.parse(savedQueue); } catch (e) { appState.queue = []; }

    const savedImgQueue = localStorage.getItem(CONFIG.STORAGE_KEYS.IMAGE_QUEUE);
    if (savedImgQueue) try { appState.imageQueue = JSON.parse(savedImgQueue); } catch (e) { appState.imageQueue = []; }

    const savedDuty = localStorage.getItem(CONFIG.STORAGE_KEYS.DUTY_STATE);
    if (savedDuty) {
        try {
            const duty = JSON.parse(savedDuty);
            appState.onDuty = duty.onDuty || false;
            appState.startOdo = duty.startOdo || 0;
            appState.shiftStartTime = duty.shiftStartTime ? new Date(duty.shiftStartTime) : null;
            appState.onBreak = duty.onBreak || false;
            appState.totalBreakDurationMs = duty.totalBreakDurationMs || 0;
        } catch (e) { }
    }
    updateQueueBadge();
}

function saveDutyState() {
    const dutyData = {
        onDuty: appState.onDuty,
        startOdo: appState.startOdo,
        shiftStartTime: appState.shiftStartTime ? appState.shiftStartTime.toISOString() : null,
        onBreak: appState.onBreak,
        totalBreakDurationMs: appState.totalBreakDurationMs
    };
    localStorage.setItem(CONFIG.STORAGE_KEYS.DUTY_STATE, JSON.stringify(dutyData));
}

function checkAuth() {
    const token = localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH);
    const userStr = localStorage.getItem(CONFIG.STORAGE_KEYS.USER);
    if (token && userStr) {
        appState.isLoggedIn = true;
        appState.user = JSON.parse(userStr);
        document.getElementById("loginOverlay").style.display = "none";
        document.getElementById("dashboardPanel").style.display = "flex";
        document.getElementById("statusText").innerText = `User: ${appState.user.username}`;
        restoreDutyUI();
        setTimeout(initMap, 100); 
        fetchSheetData();
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
    const errDiv = document.getElementById("loginError");

    if (CONFIG.USERS[u] && CONFIG.USERS[u].password === p) {
        errDiv.style.display = "none";
        const token = "TOKEN_" + Date.now();
        const userObj = { 
            username: u, 
            loginTime: new Date().toISOString(),
            spreadsheetId: CONFIG.USERS[u].spreadsheetId 
        };
        localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH, token);
        localStorage.setItem(CONFIG.STORAGE_KEYS.USER, JSON.stringify(userObj));
        checkAuth();
    } else {
        errDiv.style.display = "block";
    }
}

function logout() {
    localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.USER);
    stopGpsTracking();
    if (appState.liveTimerInterval) clearInterval(appState.liveTimerInterval);
    checkAuth();
}

function toggleTheme() {
    document.documentElement.classList.toggle("dark");
    const isDark = document.documentElement.classList.contains("dark");
    localStorage.setItem(CONFIG.STORAGE_KEYS.THEME, isDark ? "dark" : "light");
}

function updateNetworkStatus() {
    const dot = document.getElementById("statusDot");
    const text = document.getElementById("statusText");
    if (navigator.onLine) {
        dot.classList.remove("error");
        if (appState.isLoggedIn) {
            text.innerText = `Online (${appState.user.username})`;
            processQueue();       
            processImageQueue();  
        } else {
            text.innerText = "Online";
        }
    } else {
        dot.classList.add("error");
        text.innerText = "Offline Mode";
    }
}

function fetchSheetData(forceRefresh = false) {
    const sheetArea = document.getElementById("sheetArea");

    if (!forceRefresh) {
        const cached = localStorage.getItem(CONFIG.STORAGE_KEYS.DATA_CACHE);
        if (cached) {
            try {
                appState.sheetData = JSON.parse(cached);
                buildUIFromSheetData();
                return;
            } catch (e) { }
        }
    }

    if (!navigator.onLine) {
        showToast("Offline: Showing cached data.");
        return;
    }

    sheetArea.innerHTML = `<div class="loading-screen"><div class="spinner"></div><div>Loading fleet data...</div></div>`;

    fetch(`${CONFIG.APPS_SCRIPT_URL}?action=getData&sheetId=${appState.user.spreadsheetId}`)
        .then(res => res.json())
        .then(data => {
            if (data.status === "success" || data.sheets) {
                appState.sheetData = data.sheets || data;
                localStorage.setItem(CONFIG.STORAGE_KEYS.DATA_CACHE, JSON.stringify(appState.sheetData));
                buildUIFromSheetData();
                showToast("Data updated successfully.");
            } else {
                throw new Error(data.message || "Invalid structure from Apps Script");
            }
        })
        .catch(err => {
            const cached = localStorage.getItem(CONFIG.STORAGE_KEYS.DATA_CACHE);
            if (cached) {
                appState.sheetData = JSON.parse(cached);
                buildUIFromSheetData();
                showToast("Fetch failed. Loaded offline cache.");
            } else {
                sheetArea.innerHTML = `<div class="error-box">Failed to fetch data: ${err.message}</div>`;
            }
        });
}

function buildUIFromSheetData() {
    const tabBar = document.getElementById("tabBar");
    tabBar.innerHTML = "";
    const sheetNames = Object.keys(appState.sheetData);

    if (sheetNames.length === 0) {
        document.getElementById("sheetArea").innerHTML = `<div class="loading-screen">No sheet data available.</div>`;
        return;
    }

    sheetNames.forEach((name, idx) => {
        const tabBtn = document.createElement("div");
        tabBtn.className = `tab-item ${idx === 0 || name === appState.activeTab ? 'active' : ''}`;
        tabBtn.innerText = name;
        tabBtn.onclick = () => switchTab(name);
        tabBar.appendChild(tabBtn);
    });

    if (!appState.activeTab || !appState.sheetData[appState.activeTab]) {
        appState.activeTab = sheetNames[0];
    }
    switchTab(appState.activeTab);
}

function switchTab(tabName) {
    appState.activeTab = tabName;
    document.querySelectorAll(".tab-item").forEach(t => {
        t.classList.toggle("active", t.innerText === tabName);
    });

    document.getElementById("searchBox").value = "";
    populateFilterDropdown();
    applyFilterAndSearch();
}

function populateFilterDropdown() {
    const filterBox = document.getElementById("filterBox");
    filterBox.innerHTML = `<option value="all">All Rows</option>`;
    
    const rows = appState.sheetData[appState.activeTab] || [];
    if (rows.length < 2) return;

    const headers = rows[0];
    const statusColIdx = headers.findIndex(h => String(h).toLowerCase().includes("status") || String(h).toLowerCase().includes("type"));
    
    if (statusColIdx !== -1) {
        const uniqueValues = new Set();
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][statusColIdx]) uniqueValues.add(rows[i][statusColIdx]);
        }
        uniqueValues.forEach(val => {
            const opt = document.createElement("option");
            opt.value = val;
            opt.innerText = val;
            filterBox.appendChild(opt);
        });
    }
}

function handleSearchInput() { applyFilterAndSearch(); }
function handleFilterChange() { applyFilterAndSearch(); }

function applyFilterAndSearch() {
    const rows = appState.sheetData[appState.activeTab] || [];
    if (rows.length === 0) {
        renderTable([], []);
        return;
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);
    const searchTerm = document.getElementById("searchBox").value.toLowerCase().trim();
    const filterVal = document.getElementById("filterBox").value;

    appState.filteredRows = dataRows.filter(row => {
        const matchesSearch = searchTerm === "" || row.some(cell => String(cell).toLowerCase().includes(searchTerm));
        const matchesFilter = filterVal === "all" || row.some(cell => String(cell) === filterVal);
        return matchesSearch && matchesFilter;
    });

    document.getElementById("rowCount").innerText = `${appState.filteredRows.length} rows`;
    renderTable(headers, appState.filteredRows);
    calculateSubtotals(headers, appState.filteredRows);
}

function renderTable(headers, rows) {
    const sheetArea = document.getElementById("sheetArea");
    if (!headers || headers.length === 0) {
        sheetArea.innerHTML = `<div class="loading-screen">No data in sheet</div>`;
        return;
    }

    let html = `<table class="sheet-table"><thead><tr>`;
    headers.forEach(h => html += `<th>${h}</th>`);
    html += `</tr></thead><tbody>`;

    if (rows.length === 0) {
        html += `<tr><td colspan="${headers.length}" style="text-align:center;">No matching records</td></tr>`;
    } else {
        rows.forEach(row => {
            html += `<tr>`;
            headers.forEach((h, idx) => {
                const val = row[idx] !== undefined ? row[idx] : "";
                const isDateCol = String(h).toLowerCase().includes("date") || idx === 0;
                const cellClass = isDateCol ? 'class="col-date"' : '';
                
                if (typeof val === "string" && val.startsWith("http")) {
                    html += `<td ${cellClass}><a href="${val}" target="_blank" style="color: #1a73e8; text-decoration: underline; font-weight: 500;">📄 View Proof</a></td>`;
                } else {
                    html += `<td ${cellClass}>${val}</td>`;
                }
            });
            html += `</tr>`;
        });
    }

    html += `</tbody></table>`;
    sheetArea.innerHTML = html;
}

function calculateSubtotals(headers, rows) {
    const bar = document.getElementById("subtotalBar");
    bar.innerHTML = "";
    if (!rows || rows.length === 0) return;

    let statHtml = `<div class="stat-group"><span class="val-pos">Summary:</span>`;
    headers.forEach((h, colIdx) => {
        let numericValues = rows.map(r => parseFloat(String(r[colIdx]).replace(/[^0-9.-]+/g, ""))).filter(v => !isNaN(v));
        if (numericValues.length > 0 && numericValues.length >= rows.length * 0.5) {
            const sum = numericValues.reduce((a, b) => a + b, 0);
            const isCurrency = String(h).toLowerCase().includes("cost") || String(h).toLowerCase().includes("amount") || String(h).toLowerCase().includes("price") || String(h).toLowerCase().includes("₹");
            const formatted = isCurrency ? `₹${sum.toLocaleString('en-IN', {minimumFractionDigits: 2})}` : sum.toLocaleString('en-IN');
            statHtml += `<span><strong>${h}:</strong> <span class="${sum >= 0 ? 'val-pos' : 'val-neg'}">${formatted}</span></span>`;
        }
    });
    statHtml += `</div>`;
    bar.innerHTML = statHtml;
}

function restoreDutyUI() {
    const toggle = document.getElementById("dutyToggle");
    const badge = document.getElementById("dutyStatusBadge");
    const metrics = document.getElementById("dutyMetrics");
    const breakBtn = document.getElementById("breakBtn");

    toggle.checked = appState.onDuty;
    if (appState.onDuty) {
        badge.innerText = appState.onBreak ? "ON BREAK" : "ON DUTY";
        badge.style.background = appState.onBreak ? "#fff8e1" : "#e6f4ea";
        badge.style.color = appState.onBreak ? "#b78103" : "#137333";
        metrics.style.display = "grid";
        breakBtn.style.display = "inline-flex";
        breakBtn.innerText = appState.onBreak ? "▶ Resume Duty" : "🍱 Take Break";
        document.getElementById("lblStartOdo").innerText = appState.startOdo;
        startLiveShiftTimer();
        startGpsTracking();
    } else {
        badge.innerText = "OFF DUTY";
        badge.style.background = "#f1f3f4";
        badge.style.color = "#5f6368";
        metrics.style.display = "none";
        breakBtn.style.display = "none";
        if (appState.liveTimerInterval) clearInterval(appState.liveTimerInterval);
        stopGpsTracking();
    }
}

function toggleDuty(checked) {
    if (checked) {
        appState.pendingOdoType = "START";
        document.getElementById("checklistModal").style.display = "flex";
    } else {
        appState.pendingOdoType = "END";
        triggerOdometerCamera();
    }
}

function confirmChecklist() {
    document.getElementById("checklistModal").style.display = "none";
    triggerOdometerCamera();
}

function triggerOdometerCamera() {
    document.getElementById("odometerInput").click();
}

function cancelOdometerCapture() {
    document.getElementById("checklistModal").style.display = "none";
    document.getElementById("ocrModal").style.display = "none";
    document.getElementById("dutyToggle").checked = appState.onDuty;
    
    const fileInput = document.getElementById("odometerInput");
    if (fileInput) fileInput.value = ""; 
}

function handleOdometerCapture(event) {
    const file = event.target.files[0];
    if (!file) return;

    document.getElementById("ocrModal").style.display = "flex";
    document.getElementById("ocrProcessingState").style.display = "block";
    document.getElementById("ocrVerifySection").style.display = "none";
    document.getElementById("ocrStatusMsg").innerText = "Analyzing odometer image via Tesseract OCR...";

    Tesseract.recognize(file, 'eng', { logger: m => console.log(m) })
        .then(({ data: { text } }) => {
            const matches = text.match(/\b\d{4,6}\b/g);
            let detectedVal = matches ? matches[0] : "";
            document.getElementById("ocrProcessingState").style.display = "none";
            document.getElementById("ocrVerifySection").style.display = "block";
            document.getElementById("odometerInputValue").value = detectedVal;
        })
        .catch(err => {
            document.getElementById("ocrProcessingState").style.display = "none";
            document.getElementById("ocrVerifySection").style.display = "block";
            document.getElementById("odometerInputValue").value = "";
            showToast("OCR engine warning. Please enter reading manually.");
        });

    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            const MAX_WIDTH = 800; 
            const scaleSize = MAX_WIDTH / img.width;
            canvas.width = MAX_WIDTH;
            canvas.height = img.height * scaleSize;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            
            const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
            appState.currentImageBase64 = dataUrl.split(",")[1];
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function submitOdometerData() {
    const val = parseFloat(document.getElementById("odometerInputValue").value);
    if (isNaN(val) || val <= 0) { alert("Invalid odometer reading."); return; }
    document.getElementById("ocrModal").style.display = "none";

    const timestampStr = new Date().toISOString().replace(/[:.]/g, "-");
    const uniqueFilename = `Odo_${appState.user.username}_${timestampStr}.jpg`;
    let proofText = "No Image";

    if (appState.currentImageBase64) {
        proofText = uniqueFilename;
        appState.imageQueue.push({ filename: uniqueFilename, imageBase64: appState.currentImageBase64 });
        localStorage.setItem(CONFIG.STORAGE_KEYS.IMAGE_QUEUE, JSON.stringify(appState.imageQueue));
    }

    const commonPayload = { user: appState.user.username, timestamp: new Date().toISOString(), imageProof: proofText };

    if (appState.pendingOdoType === "START") {
        appState.onDuty = true; appState.startOdo = val; appState.shiftStartTime = new Date(); appState.totalBreakDurationMs = 0; appState.onBreak = false;
        saveDutyState(); restoreDutyUI();
        addToQueue({ ...commonPayload, type: "DUTY_START", odometer: val });
        showToast("Shift started!"); checkMaintenanceAlert(val);
    } else if (appState.pendingOdoType === "END") {
        const endOdo = val; const totalKm = endOdo - appState.startOdo;
        const endTime = new Date(); const durationMin = Math.round((endTime - appState.shiftStartTime - appState.totalBreakDurationMs) / 60000);
        appState.onDuty = false; appState.onBreak = false;
        saveDutyState(); restoreDutyUI();
        addToQueue({ ...commonPayload, type: "DUTY_END", startOdo: appState.startOdo, endOdo: endOdo, distanceKm: totalKm, durationMinutes: durationMin });
        showToast(`Shift ended! Distance: ${totalKm} km in ${durationMin} mins.`);
    }

    appState.currentImageBase64 = null;
    processImageQueue(); 
}

function toggleBreak() {
    if (!appState.onDuty) return;

    if (!appState.onBreak) {
        appState.onBreak = true;
        appState.breakStartTime = new Date();
        showToast("Break started.");
    } else {
        appState.onBreak = false;
        if (appState.breakStartTime) {
            appState.totalBreakDurationMs += (new Date() - appState.breakStartTime);
            appState.breakStartTime = null;
        }
        showToast("Resumed duty.");
    }
    saveDutyState();
    restoreDutyUI();
}

function startLiveShiftTimer() {
    if (appState.liveTimerInterval) clearInterval(appState.liveTimerInterval);
    appState.liveTimerInterval = setInterval(() => {
        if (!appState.shiftStartTime) return;
        let elapsed = new Date() - appState.shiftStartTime - appState.totalBreakDurationMs;
        if (appState.onBreak && appState.breakStartTime) {
            elapsed -= (new Date() - appState.breakStartTime);
        }
        if (elapsed < 0) elapsed = 0;
        const hrs = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
        const mins = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
        document.getElementById("lblLiveTime").innerText = `${hrs}h ${mins}m`;
    }, 1000);
}

function initMap() {
    if (appState.map) {
        setTimeout(() => appState.map.invalidateSize(), 200);
        return;
    }
    
    appState.map = L.map('map').setView([CONFIG.MAP.DEFAULT_LAT, CONFIG.MAP.DEFAULT_LNG], CONFIG.MAP.ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(appState.map);

    appState.routePolyline = L.polyline([], { color: '#188038', weight: 4 }).addTo(appState.map);
    setTimeout(() => appState.map.invalidateSize(), 200);
}

function startGpsTracking() {
    if (!navigator.geolocation) return;
    appState.routeCoords = [];
    appState.gpsWatchId = navigator.geolocation.watchPosition(
        (pos) => {
            const { latitude, longitude } = pos.coords;
            const latLng = [latitude, longitude];
            appState.routeCoords.push(latLng);

            if (!appState.userMarker) {
                appState.userMarker = L.marker(latLng).addTo(appState.map);
            } else {
                appState.userMarker.setLatLng(latLng);
            }
            appState.routePolyline.setLatLngs(appState.routeCoords);
            appState.map.panTo(latLng);
        },
        (err) => console.warn("GPS tracking error:", err),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
}

function stopGpsTracking() {
    if (appState.gpsWatchId !== null) {
        navigator.geolocation.clearWatch(appState.gpsWatchId);
        appState.gpsWatchId = null;
    }
}

function openExpenseModal() {
    document.getElementById("expenseModal").style.display = "flex";
}

function handleReceiptCapture(event) {
    const file = event.target.files[0];
    if (!file) {
        appState.currentReceiptBase64 = null;
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            const MAX_WIDTH = 800;
            const scaleSize = MAX_WIDTH / img.width;
            canvas.width = MAX_WIDTH;
            canvas.height = img.height * scaleSize;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            
            const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
            appState.currentReceiptBase64 = dataUrl.split(",")[1];
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function handleExpenseSubmit(e) {
    e.preventDefault();
    const type = document.getElementById("expType").value;
    const qty = parseFloat(document.getElementById("expQty").value);
    const cost = parseFloat(document.getElementById("expCost").value);
    const odo = parseFloat(document.getElementById("expOdo").value);

    const timestampStr = new Date().toISOString().replace(/[:.]/g, "-");
    const uniqueFilename = `Exp_${type}_${appState.user.username}_${timestampStr}.jpg`;
    let proofText = "No Image";

    if (appState.currentReceiptBase64) {
        proofText = uniqueFilename;
        appState.imageQueue.push({ filename: uniqueFilename, imageBase64: appState.currentReceiptBase64 });
        localStorage.setItem(CONFIG.STORAGE_KEYS.IMAGE_QUEUE, JSON.stringify(appState.imageQueue));
    }

    addToQueue({
        type: "EXPENSE", user: appState.user.username, category: type, quantity: qty, cost: cost,
        odometer: odo, timestamp: new Date().toISOString(), imageProof: proofText
    });

    closeExpenseModal();
    showToast("Expense recorded.");
    processImageQueue();
}

function closeExpenseModal() {
    document.getElementById("expenseModal").style.display = "none";
    appState.currentReceiptBase64 = null;
    const receiptInput = document.getElementById("expReceiptInput");
    if (receiptInput) receiptInput.value = "";
    document.querySelector("#expenseModal form").reset();
}

function addToQueue(item) {
    appState.queue.push(item);
    localStorage.setItem(CONFIG.STORAGE_KEYS.QUEUE, JSON.stringify(appState.queue));
    updateQueueBadge();
    processQueue();
}

function updateQueueBadge() {
    const badge = document.getElementById("queueBadge");
    const totalQueued = appState.queue.length + appState.imageQueue.length;
    badge.innerText = `${totalQueued} queued`;
    badge.className = `queue-badge ${totalQueued > 0 ? 'has-items' : ''}`;
}

function processQueue() {
    if (!navigator.onLine || appState.queue.length === 0) return;

    const item = appState.queue[0];
    item.spreadsheetId = appState.user.spreadsheetId;

    fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(item)
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === "success") {
            appState.queue.shift(); 
            localStorage.setItem(CONFIG.STORAGE_KEYS.QUEUE, JSON.stringify(appState.queue));
            updateQueueBadge();
            
            if (appState.queue.length > 0) processQueue();
            else fetchSheetData(true);
        } else {
            console.error("Sheet error:", data.message);
        }
    })
    .catch(err => {
        console.error("Queue process error:", err);
    });
}

function processImageQueue() {
    if (!navigator.onLine || appState.imageQueue.length === 0) return;

    const item = appState.imageQueue[0];
    
    fetch(CONFIG.TERMUX_SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item)
    })
    .then(res => {
        if (res.ok) {
            appState.imageQueue.shift();
            localStorage.setItem(CONFIG.STORAGE_KEYS.IMAGE_QUEUE, JSON.stringify(appState.imageQueue));
            updateQueueBadge();
            if (appState.imageQueue.length > 0) processImageQueue();
        } else {
            console.warn("Termux API rejected the image.");
        }
    })
    .catch(err => {
        console.warn("Termux offline or unreachable. Image kept in queue.", err);
    });
}

function triggerVoiceInput() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        showToast("Voice recognition not supported on this browser.");
        return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    showToast("Listening... speak expense or command.");
    recognition.start();

    recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        showToast(`Heard: "${transcript}"`);
        parseVoiceCommand(transcript);
    };
}

function parseVoiceCommand(cmd) {
    const lower = cmd.toLowerCase();
    const numMatches = lower.match(/\d+/g);
    if (lower.includes("expense") || lower.includes("petrol") || lower.includes("cng") || lower.includes("fuel")) {
        openExpenseModal();
        if (numMatches && numMatches[0]) {
            document.getElementById("expCost").value = numMatches[0];
        }
    } else if (lower.includes("start shift") || lower.includes("on duty")) {
        toggleDuty(true);
    } else if (lower.includes("end shift") || lower.includes("off duty")) {
        toggleDuty(false);
    }
}

function exportShiftCSV() {
    const rows = appState.sheetData[appState.activeTab] || [];
    if (rows.length === 0) {
        showToast("No data to export.");
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8," + rows.map(e => e.map(c => `"${c}"`).join(",")).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${appState.activeTab}_Export_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function checkMaintenanceAlert(odoVal) {
    const alertCard = document.getElementById("maintenanceAlertCard");
    let alerts = [];
    
    if (odoVal % CONFIG.MAINTENANCE_THRESHOLDS.oilChange < 300) alerts.push("Oil Change");
    if (odoVal % CONFIG.MAINTENANCE_THRESHOLDS.tireRotation < 300) alerts.push("Tire Rotation");
    if (odoVal % CONFIG.MAINTENANCE_THRESHOLDS.brakeInspection < 300) alerts.push("Brake Inspection");

    if (alerts.length > 0) {
        alertCard.style.display = "block";
        alertCard.innerHTML = `<strong>⚠️ Maintenance Due Alert</strong>: Odometer at ${odoVal} km is near scheduled service for: <strong>${alerts.join(", ")}</strong>.`;
    } else {
        alertCard.style.display = "none";
    }
}

function showDiagnostics() {
    alert(`Diagnostics Report:\n- Online Status: ${navigator.onLine}\n- Data Queue: ${appState.queue.length}\n- Image Queue: ${appState.imageQueue.length}\n- Current Tab: ${appState.activeTab}\n- Active GPS Track Points: ${appState.routeCoords.length}`);
}

function showToast(msg) {
    const toast = document.getElementById("toast");
    toast.innerText = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}
