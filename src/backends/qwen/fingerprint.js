/**
 * 指纹生成模块
 * （用于生成 ssxmod_itna Cookie 所需的指纹字符串）
 */

// 默认指纹模板（基于 Apple M4 Mac 采集）
const DEFAULT_TEMPLATE = {
    deviceId: '84985177a19a010dea49',
    sdkVersion: 'websdk-2.3.15d',
    initTimestamp: '1765348410850',
    field3: '91',
    field4: '1|15',
    language: 'zh-CN',
    timezoneOffset: '-480',
    colorDepth: '16705151|12791',
    screenInfo: '1470|956|283|797|158|0|1470|956|1470|798|0|0',
    field9: '5',
    platform: 'MacIntel',
    field11: '10',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)',
    field13: '30|30',
    field14: '0',
    field15: '28',
    pluginCount: '5',
    vendor: 'Google Inc.',
    field29: '8',
    touchInfo: '-1|0|0|0|0',
    field32: '11',
    field35: '0',
    mode: 'P'
};

// 屏幕分辨率预设
const SCREEN_PRESETS = {
    '1920x1080': '1920|1080|283|1080|158|0|1920|1080|1920|922|0|0',
    '2560x1440': '2560|1440|283|1440|158|0|2560|1440|2560|1282|0|0',
    '1470x956': '1470|956|283|797|158|0|1470|956|1470|798|0|0',
    '1440x900': '1440|900|283|900|158|0|1440|900|1440|742|0|0',
    '1536x864': '1536|864|283|864|158|0|1536|864|1536|706|0|0'
};

// 平台预设
const PLATFORM_PRESETS = {
    macIntel: {
        platform: 'MacIntel',
        webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)',
        vendor: 'Google Inc.'
    },
    macM1: {
        platform: 'MacIntel',
        webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)|Google Inc. (Apple)',
        vendor: 'Google Inc.'
    },
    win64: {
        platform: 'Win32',
        webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)|Google Inc. (NVIDIA)',
        vendor: 'Google Inc.'
    },
    linux: {
        platform: 'Linux x86_64',
        webglRenderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, OpenGL 4.6)|Google Inc. (Intel)',
        vendor: 'Google Inc.'
    }
};

// 语言预设
const LANGUAGE_PRESETS = {
    'zh-CN': { language: 'zh-CN', timezoneOffset: '-480' },
    'zh-TW': { language: 'zh-TW', timezoneOffset: '-480' },
    'en-US': { language: 'en-US', timezoneOffset: '480' },
    'ja-JP': { language: 'ja-JP', timezoneOffset: '-540' },
    'ko-KR': { language: 'ko-KR', timezoneOffset: '-540' }
};

/**
 * 生成设备 ID
 * @returns {string} 20 位十六进制随机字符串
 */
function generateDeviceId() {
    return Array.from({ length: 20 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join('');
}

/**
 * 生成哈希值
 * @returns {number} 32 位随机整数
 */
function generateHash() {
    return Math.floor(Math.random() * 4294967296);
}

/**
 * 生成指纹字符串
 * @param {Object} options - 配置选项
 * @param {string} [options.deviceId] - 设备 ID，不传则自动生成
 * @param {string} [options.platform] - 平台类型: 'macIntel' | 'macM1' | 'win64' | 'linux'
 * @param {string} [options.screen] - 屏幕分辨率: '1920x1080' | '2560x1440' | '1470x956' | '1440x900' | '1536x864'
 * @param {string} [options.locale] - 语言区域: 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR'
 * @param {Object} [options.custom] - 自定义覆盖字段
 * @returns {string} 指纹字符串
 */
function generateFingerprint(options = {}) {
    const config = { ...DEFAULT_TEMPLATE };

    // 应用平台预设
    if (options.platform && PLATFORM_PRESETS[options.platform]) {
        Object.assign(config, PLATFORM_PRESETS[options.platform]);
    }

    // 应用屏幕分辨率预设
    if (options.screen && SCREEN_PRESETS[options.screen]) {
        config.screenInfo = SCREEN_PRESETS[options.screen];
    }

    // 应用语言预设
    if (options.locale && LANGUAGE_PRESETS[options.locale]) {
        Object.assign(config, LANGUAGE_PRESETS[options.locale]);
    }

    // 应用自定义字段
    if (options.custom) {
        Object.assign(config, options.custom);
    }

    // 设备 ID
    const deviceId = options.deviceId || generateDeviceId();

    // 当前时间戳
    const currentTimestamp = Date.now();

    // 生成各类哈希值
    const pluginHash = generateHash();
    const canvasHash = generateHash();
    const uaHash1 = generateHash();
    const uaHash2 = generateHash();
    const urlHash = generateHash();
    const docHash = Math.floor(Math.random() * 91) + 10;

    // 组装 37 个字段的指纹串
    const fields = [
        deviceId,                                   // 0: 设备 ID
        config.sdkVersion,                          // 1: SDK 版本
        config.initTimestamp,                       // 2: 初始化时间戳
        config.field3,                              // 3: 字段3
        config.field4,                              // 4: 字段4
        config.language,                            // 5: 语言
        config.timezoneOffset,                      // 6: 时区偏移
        config.colorDepth,                          // 7: 色深
        config.screenInfo,                          // 8: 屏幕信息
        config.field9,                              // 9: 字段9
        config.platform,                            // 10: 平台
        config.field11,                             // 11: 字段11
        config.webglRenderer,                       // 12: WebGL 渲染器
        config.field13,                             // 13: 字段13
        config.field14,                             // 14: 字段14
        config.field15,                             // 15: 字段15
        `${config.pluginCount}|${pluginHash}`,      // 16: 插件数量|插件哈希
        canvasHash,                                 // 17: Canvas 哈希
        uaHash1,                                    // 18: UA 哈希1
        '1',                                        // 19: 字段19
        '0',                                        // 20: 字段20
        '1',                                        // 21: 字段21
        '0',                                        // 22: 字段22
        config.mode,                                // 23: 模式
        '0',                                        // 24: 字段24
        '0',                                        // 25: 字段25
        '0',                                        // 26: 字段26
        '416',                                      // 27: 字段27
        config.vendor,                              // 28: 浏览器厂商
        config.field29,                             // 29: 字段29
        config.touchInfo,                           // 30: 触摸信息
        uaHash2,                                    // 31: UA 哈希2
        config.field32,                             // 32: 字段32
        currentTimestamp,                           // 33: 当前时间戳
        urlHash,                                    // 34: URL 哈希
        config.field35,                             // 35: 字段35
        docHash                                     // 36: 文档哈希
    ];

    return fields.join('^');
}

module.exports = {
    generateFingerprint,
    generateDeviceId,
    generateHash,
    DEFAULT_TEMPLATE,
    SCREEN_PRESETS,
    PLATFORM_PRESETS,
    LANGUAGE_PRESETS
};
