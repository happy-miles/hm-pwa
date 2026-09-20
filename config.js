const CONFIG = {
    APP_NAME: "Happy Miles",
    COMPANY_NAME: "Happy Miles",
    // Paste your Web app URL ending in /exec here:
    APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycby4ooO1COPSDGZImInE83qC9YeTSHYbRx4ccr21venHsuO8xR4TT5uBN39vxp5ZP-MOrg/exec",
    TERMUX_SERVER_URL: "https://repair-paver-passive.ngrok-free.dev/upload",
    STORAGE_KEYS: {
        AUTH: "hm_auth_token",
        USER: "hm_user_info",
        DATA_CACHE: "hm_sheet_cache",
        QUEUE: "hm_offline_queue",
        IMAGE_QUEUE: "hm_image_queue",
        DUTY_STATE: "hm_duty_state",
        THEME: "hm_theme"
    },
    USERS: {
        // Map your logins to your actual Spreadsheet ID:
        'admin': { password: 'abhishek', spreadsheetId: '1PnDOUa6Jp7WsAy2DlpNJQ12j1fpyOtAghu_UHGEuK0c' },
        'main': { password: 'abhi123', spreadsheetId: '1GW7reZMUtYDoc-26DeIBs4bOSM31k8U0JfKidozbkOs' },
        '7944': { password: '7944', spreadsheetId: '1x0BnUziYQemws3Wd0vzsjGxLBoVeLX02fQzdJ6CEuLg' }
    },
    MAP: {
        DEFAULT_LAT: 19.8762,
        DEFAULT_LNG: 75.3433,
        ZOOM: 14
    },
    MAINTENANCE_THRESHOLDS: {
        oilChange: 5000,
        tireRotation: 10000,
        brakeInspection: 15000
    }
};
