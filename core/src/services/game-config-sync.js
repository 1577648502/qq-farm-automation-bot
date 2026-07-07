const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { getDataDir, getResourcePath, isPackaged } = require('../config/runtime-paths');

const QQ_FARM_APP_ID = '1112386029';
// macOS: QQ 小程序缓存路径
const QQ_CACHE_RELATIVE_ROOT = path.join(
    'Library',
    'Containers',
    'com.tencent.qqexminiprogram',
    'Data',
    'Library',
    'Application Support',
    'QQEX',
    'miniapp',
    'fs',
);
// Windows: QQEX 小程序缓存路径
const WINDOWS_QQ_CACHE_ROOT = path.join(
    'AppData',
    'Roaming',
    'QQEX',
    'miniapp',
    'fs',
);
// Windows: QQNT QQAppData 路径
const WINDOWS_QQNT_CACHE_ROOT = path.join(
    'Documents',
    'Tencent Files',
    'All Users',
    'QQAppData',
);
const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEX_KEYS = '0123456789abcdef';

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeAtomic(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
}

function writeJsonAtomic(filePath, value) {
    writeAtomic(filePath, `${JSON.stringify(value, null, 4)}\n`);
}

function filesEqual(leftPath, rightPath) {
    if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) return false;
    return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
}

function overwriteBundledConfigs(itemSourcePath, plantSourcePath, imageSourceDir) {
    if (isPackaged) return false;
    const bundledItemPath = getResourcePath('gameConfig', 'ItemInfo.json');
    let updated = false;
    // 同步 ItemInfo.json（Plant.json 等级数据不准确，跳过覆盖）
    if (!filesEqual(itemSourcePath, bundledItemPath)) {
        writeAtomic(bundledItemPath, fs.readFileSync(itemSourcePath));
        updated = true;
    }
    // 同步种子图片到内置目录（前端从 src/gameConfig/seed_images_named 加载）
    if (imageSourceDir && fs.existsSync(imageSourceDir)) {
        const bundledImageDir = getResourcePath('gameConfig', 'seed_images_named');
        fs.mkdirSync(bundledImageDir, { recursive: true });
        var sourceFiles = fs.readdirSync(imageSourceDir);
        for (var i = 0; i < sourceFiles.length; i++) {
            var srcPath = path.join(imageSourceDir, sourceFiles[i]);
            var dstPath = path.join(bundledImageDir, sourceFiles[i]);
            if (fs.statSync(srcPath).isFile()) {
                if (!fs.existsSync(dstPath) || !filesEqual(srcPath, dstPath)) {
                    writeAtomic(dstPath, fs.readFileSync(srcPath));
                    updated = true;
                }
            }
        }
    }
    return updated;
}

function scanCacheDir(fsRoot, hasAccountDir) {
    if (!fs.existsSync(fsRoot)) return [];
    var candidates = [];
    try {
        var dirs = fs.readdirSync(fsRoot);
        for (var i = 0; i < dirs.length; i++) {
            var gameCachesDir = hasAccountDir
                ? path.join(fsRoot, dirs[i], QQ_FARM_APP_ID, 'usr', 'gamecaches')
                : path.join(fsRoot, QQ_FARM_APP_ID, 'usr', 'gamecaches');
            var cacheListPath = path.join(gameCachesDir, 'cacheList.json');
            if (!fs.existsSync(cacheListPath)) continue;
            candidates.push({
                gameCachesDir: gameCachesDir,
                cacheListPath: cacheListPath,
                mtimeMs: fs.statSync(cacheListPath).mtimeMs,
            });
        }
    } catch (e) {}
    return candidates;
}

function findLatestQQFarmCache() {
    var candidates = [];
    // macOS
    candidates.push.apply(candidates, scanCacheDir(path.join(os.homedir(), QQ_CACHE_RELATIVE_ROOT), true));
    // Windows QQEX
    candidates.push.apply(candidates, scanCacheDir(path.join(os.homedir(), WINDOWS_QQ_CACHE_ROOT), true));
    // Windows QQNT
    candidates.push.apply(candidates, scanCacheDir(path.join(os.homedir(), WINDOWS_QQNT_CACHE_ROOT), false));
    candidates.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });
    return candidates[0] || null;
}

function qqFileUrlToPath(gameCachesDir, value) {
    const text = String(value || '');
    if (!text.startsWith('qqfile://usr/')) return '';
    return path.join(path.dirname(gameCachesDir), text.slice('qqfile://usr/'.length));
}

function decompressUuid(compressed) {
    const text = String(compressed || '');
    if (text.length !== 22) return text.split('@')[0];
    let hex = text.slice(0, 2);
    for (let i = 2; i < 22; i += 2) {
        const left = BASE64_KEYS.indexOf(text[i]);
        const right = BASE64_KEYS.indexOf(text[i + 1]);
        if (left < 0 || right < 0) return text;
        hex += HEX_KEYS[left >> 2];
        hex += HEX_KEYS[((left & 3) << 2) | (right >> 4)];
        hex += HEX_KEYS[right & 15];
    }
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function getAssetVersion(bundleConfig, kind, assetIndex) {
    const versions = bundleConfig && bundleConfig.versions && bundleConfig.versions[kind];
    if (!Array.isArray(versions)) return '';
    for (let i = 0; i < versions.length; i += 2) {
        if (Number(versions[i]) === Number(assetIndex)) return String(versions[i + 1] || '');
    }
    return '';
}

function findBundleConfig(cacheList, cache, bundleName) {
    const entries = Object.entries(cacheList.files || {})
        .filter(([url, value]) => value && value.bundle === bundleName && new RegExp(`/${bundleName}/config\\.[^/]+\\.json$`).test(url))
        .sort((a, b) => Number(b[1].lastTime) - Number(a[1].lastTime));
    if (!entries.length) throw new Error(`QQ缓存中未找到 ${bundleName} 配置清单`);

    const [sourceUrl, cacheEntry] = entries[0];
    const localPath = qqFileUrlToPath(cache.gameCachesDir, cacheEntry.url || sourceUrl);
    if (!localPath || !fs.existsSync(localPath)) throw new Error(`QQ缓存中的 ${bundleName} 配置文件不存在`);
    return { sourceUrl, config: readJson(localPath) };
}

function resolveJsonAsset(bundleConfig, configUrl, assetPath) {
    const pathEntry = Object.entries(bundleConfig.paths || {})
        .find(([, value]) => Array.isArray(value) && value[0] === assetPath);
    if (!pathEntry) throw new Error(`QQ缓存资源索引中未找到 ${assetPath}`);

    const assetIndex = Number(pathEntry[0]);
    const uuid = decompressUuid(bundleConfig.uuids && bundleConfig.uuids[assetIndex]);
    const version = getAssetVersion(bundleConfig, 'import', assetIndex);
    if (!uuid || !version) throw new Error(`${assetPath} 的 UUID 或版本号无效`);

    const baseUrl = new URL(configUrl);
    baseUrl.pathname = baseUrl.pathname.replace(/config\.[^/]+\.json$/, '');
    return new URL(`import/${uuid.slice(0, 2)}/${uuid}.${version}.json`, baseUrl).toString();
}

function downloadBuffer(url, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { timeout: 20000 }, (response) => {
            const status = Number(response.statusCode) || 0;
            if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
                response.resume();
                resolve(downloadBuffer(new URL(response.headers.location, url).toString(), redirectsLeft - 1));
                return;
            }
            if (status !== 200) {
                response.resume();
                reject(new Error(`下载失败 HTTP ${status}: ${url}`));
                return;
            }
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
        });
        request.on('timeout', () => request.destroy(new Error(`下载超时: ${url}`)));
        request.on('error', reject);
    });
}

async function readCachedOrRemote(cache, cacheList, url) {
    const entry = cacheList.files && cacheList.files[url];
    const localPath = qqFileUrlToPath(cache.gameCachesDir, entry && entry.url);
    if (localPath && fs.existsSync(localPath)) return fs.readFileSync(localPath);
    return downloadBuffer(url);
}

function decodeCocosJsonAsset(serialized, expectedName) {
    const rows = serialized && serialized[5];
    if (!Array.isArray(rows)) throw new Error(`${expectedName} 不是可识别的 Cocos JsonAsset`);
    const row = rows.find(value => Array.isArray(value) && value[1] === expectedName && Array.isArray(value[2]));
    if (!row) throw new Error(`${expectedName} JsonAsset 中没有配置数组`);
    return row[2];
}

function parseSellInfo(value) {
    const first = String(value || '').split(';')[0];
    const match = first.match(/^(\d+):(\d+)$/);
    if (!match) return { priceId: 0, price: 0 };
    const currencyId = Number(match[1]) || 0;
    return {
        priceId: currencyId === 1001 ? 0 : currencyId,
        price: Number(match[2]) || 0,
    };
}

function normalizeItem(item) {
    const sell = parseSellInfo(item && item.sells);
    return {
        id: Number(item && item.id) || 0,
        type: Number(item && item.type) || 0,
        name: String((item && item.name) || ''),
        interaction_type: String((item && item.interaction_type) || ''),
        price_id: sell.priceId,
        price: sell.price,
        level: Number(item && item.level) || 0,
        target_id: Number(item && item.target_id) || 0,
        asset_name: String((item && item.asset_name) || ''),
        icon_res: String((item && item.icon_res) || ''),
        max_count: Number(item && item.max_count) || 0,
        max_own: Number(item && item.max_own) || 0,
        can_use: Number(item && item.can_use) || 0,
        desc: String((item && item.desc) || ''),
        effectDesc: String((item && item.effectDesc) || ''),
        trait_id: Number(item && (item.trait_id ?? item['trait_id '])) || 0,
        layer: Number(item && item.layer) || 0,
        rarity: Number(item && item.rarity) || 0,
        rarity_color: String((item && item.rarity_color) || ''),
        jumps: String((item && item.jumps) || ''),
        ware_scale: item && item.ware_scale != null ? item.ware_scale : null,
    };
}

function mergeById(bundledValues, officialValues, normalize = value => value) {
    const officialById = new Map();
    for (const value of officialValues) {
        const normalized = normalize(value);
        const id = Number(normalized && normalized.id) || 0;
        if (id > 0) officialById.set(id, normalized);
    }

    const merged = [];
    const seen = new Set();
    for (const oldValue of bundledValues) {
        const id = Number(oldValue && oldValue.id) || 0;
        if (id <= 0 || seen.has(id)) continue;
        merged.push(officialById.get(id) || oldValue);
        seen.add(id);
    }
    for (const [id, value] of officialById) {
        if (seen.has(id)) continue;
        merged.push(value);
        seen.add(id);
    }
    return merged;
}

function buildSeedAssetIndex(bundleConfig) {
    const assets = new Map();
    for (const [indexText, value] of Object.entries(bundleConfig.paths || {})) {
        if (!Array.isArray(value) || Number(value[1]) !== 0) continue;
        const assetPath = String(value[0] || '');
        if (!assetPath.endsWith('_Seed') || assetPath.includes('/gold/')) continue;
        const key = path.posix.basename(assetPath);
        if (!assets.has(key)) assets.set(key, Number(indexText));
    }
    return assets;
}

function buildAssetPathIndex(bundleConfig) {
    const assets = new Map();
    for (const [indexText, value] of Object.entries(bundleConfig.paths || {})) {
        if (!Array.isArray(value)) continue;
        const assetPath = String(value[0] || '');
        if (assetPath && !assets.has(assetPath)) assets.set(assetPath, Number(indexText));
    }
    return assets;
}

function getSeedAssetCandidates(item) {
    const candidates = [];
    const add = (value) => {
        const text = String(value || '').trim();
        if (text && !candidates.includes(text)) candidates.push(text);
    };
    add(item.asset_name);

    const targetId = String(Number(item.target_id) || '');
    if (targetId.startsWith('102')) add(`Crop_${Number(targetId.slice(3))}`);

    const seedId = Number(item.id) || 0;
    if (seedId >= 20000 && seedId < 30000) add(`Crop_${seedId - 20000}`);

    const assetMatch = String(item.asset_name || '').match(/^Crop_102(\d+)$/);
    if (assetMatch) add(`Crop_${Number(assetMatch[1])}`);

    // Add _Seed suffixed versions to match buildSeedAssetIndex keys
    var suffixList = [];
    for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].indexOf('_Seed') === -1) {
            suffixList.push(candidates[i] + '_Seed');
        }
    }
    for (var i = 0; i < suffixList.length; i++) {
        if (candidates.indexOf(suffixList[i]) === -1) candidates.push(suffixList[i]);
    }

    return candidates;
}

function sanitizeFilename(value) {
    return String(value || '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '')
        .slice(0, 60);
}

function resolveNativeAsset(bundleConfig, bundleConfigUrl, cacheList, assetIndex) {
    const uuid = decompressUuid(bundleConfig.uuids && bundleConfig.uuids[assetIndex]);
    const version = getAssetVersion(bundleConfig, 'native', assetIndex);
    if (!uuid || !version) return null;

    const baseUrl = new URL(bundleConfigUrl);
    baseUrl.pathname = baseUrl.pathname.replace(/config\.[^/]+\.json$/, '');
    const prefix = new URL(`native/${uuid.slice(0, 2)}/${uuid}.${version}.`, baseUrl).toString();
    const cachedUrl = Object.keys(cacheList.files || {}).find(url => url.startsWith(prefix));
    return { uuid, url: cachedUrl || `${prefix}png` };
}

async function mapLimit(values, limit, worker) {
    let cursor = 0;
    const results = Array.from({ length: values.length });
    async function run() {
        while (cursor < values.length) {
            const index = cursor++;
            results[index] = await worker(values[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
    return results;
}

/**
 * Create a minimal 1x1 white PNG placeholder
 * Used when CDN/bundle image not available
 */
function writePlaceholderPng(filePath, label) {
    var png = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
        0x00, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
        0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
    ]);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, png);
}

async function syncSeedImages(cache, cacheList, plantBundle, items, outputDir) {
    const assetIndex = buildSeedAssetIndex(plantBundle.config);
    const seeds = items.filter(item => Number(item && item.type) === 5 && Number(item.id) > 0);
    const bundledImageDir = getResourcePath('gameConfig', 'seed_images_named');
    const bundledFiles = fs.existsSync(bundledImageDir) ? fs.readdirSync(bundledImageDir) : [];
    fs.mkdirSync(outputDir, { recursive: true });

    const missing = [];
    const errors = [];
    let syncedCount = 0;
    let cachedCount = 0;
    let bundledCount = 0;
    await mapLimit(seeds, 6, async (item) => {
        const displayName = sanitizeFilename(String(item.name || '').replace(/种子$/, ''));
        const mappedAssetName = sanitizeFilename(item.asset_name || `Crop_${Number(item.id)}`);
        const findBundledFallback = () => bundledFiles.find((file) => {
            return file.startsWith(`${Number(item.id)}_`)
                || (mappedAssetName && file.includes(`${mappedAssetName}_Seed`));
        });
        const useBundledFallback = () => {
            const fallback = findBundledFallback();
            if (!fallback) return false;
            const ext = path.extname(fallback) || '.png';
            const filename = `${Number(item.id)}_${displayName}_${mappedAssetName}_Seed${ext}`;
            writeAtomic(path.join(outputDir, filename), fs.readFileSync(path.join(bundledImageDir, fallback)));
            syncedCount++;
            bundledCount++;
            return true;
        };

        const candidate = getSeedAssetCandidates(item).find(name => assetIndex.has(name));
        if (!candidate) {
            if (useBundledFallback()) return;
            // fallback: generate placeholder for missing image
            writePlaceholderPng(path.join(outputDir, filename), displayName || String(item.id));
            syncedCount++;
            return;
        }

        const nativeAsset = resolveNativeAsset(
            plantBundle.config,
            plantBundle.sourceUrl,
            cacheList,
            assetIndex.get(candidate),
        );
        if (!nativeAsset) {
            if (useBundledFallback()) return;
            // fallback: generate placeholder for missing image
            writePlaceholderPng(path.join(outputDir, filename), displayName || String(item.id));
            syncedCount++;
            return;
        }

        const cachedEntry = cacheList.files && cacheList.files[nativeAsset.url];
        const cachedPath = qqFileUrlToPath(cache.gameCachesDir, cachedEntry && cachedEntry.url);
        const ext = path.extname(new URL(nativeAsset.url).pathname) || '.png';
        const filename = `${Number(item.id)}_${displayName}_${mappedAssetName}_Seed${ext}`;
        try {
            const content = await readCachedOrRemote(cache, cacheList, nativeAsset.url);
            writeAtomic(path.join(outputDir, filename), content);
            syncedCount++;
            if (cachedPath && fs.existsSync(cachedPath)) cachedCount++;
        } catch (error) {
            errors.push({ id: item.id, error: error.message });
        }
    });

    return { syncedCount, cachedCount, bundledCount, missing, errors };
}

function getPlantItemAssetCandidates(item) {
    const assetName = String(item && item.asset_name || '').trim().replace(/^\/+|\/+$/g, '');
    if (!assetName) return [];

    const names = [];
    const add = (value) => {
        if (value && !names.includes(value)) names.push(value);
    };
    add(assetName);

    const cropMatch = assetName.match(/^Crop_102(\d+)$/);
    if (cropMatch) add(`Crop_${Number(cropMatch[1])}`);

    const isSeed = Number(item.type) === 5;
    const paths = [];
    for (const name of names) {
        if (isSeed) {
            paths.push(`model/v4/${name}_Seed`);
        } else {
            paths.push(`model/v4/${name}`);
            paths.push(`model/v4/${name}_Seed`);
        }
    }
    return paths;
}

function getIconAssetCandidates(item) {
    const iconRes = String(item && item.icon_res || '').trim().replace(/^\/+|\/+$/g, '');
    if (!iconRes) return [];
    const base = iconRes.replace(/\/(?:spriteFrame|texture)$/, '');
    return base ? [base] : [];
}

async function syncOtherItemImages(cache, cacheList, bundles, items, outputDir) {
    const bundleIndexes = bundles.map(bundle => ({
        ...bundle,
        assetIndex: buildAssetPathIndex(bundle.config),
    }));
    const plantBundle = bundleIndexes.find(bundle => bundle.config.name === 'plant');
    const iconBundles = bundleIndexes.filter(bundle => bundle.config.name !== 'plant');
    const bundledImageDir = getResourcePath('gameConfig', 'seed_images_named');
    const bundledFiles = fs.existsSync(bundledImageDir) ? fs.readdirSync(bundledImageDir) : [];
    const targets = items.filter(item => Number(item && item.type) !== 5
        && Number(item && item.id) > 0
        && (String(item.asset_name || '').trim() || String(item.icon_res || '').trim()));

    let syncedCount = 0;
    let cachedCount = 0;
    let bundledCount = 0;
    const missing = [];
    const errors = [];
    await mapLimit(targets, 6, async (item) => {
        const itemId = Number(item.id);
        const assetName = String(item.asset_name || '').trim();
        const iconRes = String(item.icon_res || '').trim();
        const displayName = sanitizeFilename(item.name || `物品${itemId}`);
        const tag = sanitizeFilename(iconRes ? path.posix.basename(iconRes.replace(/\/spriteFrame$/, '')) : assetName);
        const findBundledFallback = () => bundledFiles.find((file) => {
            return file.startsWith(`${itemId}_`)
                || (assetName && file.includes(`${sanitizeFilename(assetName)}_Seed`));
        });
        const useBundledFallback = () => {
            const fallback = findBundledFallback();
            if (!fallback) return false;
            const ext = path.extname(fallback) || '.png';
            writeAtomic(
                path.join(outputDir, `${itemId}_${displayName}_${tag || 'icon'}${ext}`),
                fs.readFileSync(path.join(bundledImageDir, fallback)),
            );
            syncedCount++;
            bundledCount++;
            return true;
        };

        let matched = null;
        const iconCandidates = getIconAssetCandidates(item);
        for (const bundle of iconBundles) {
            const assetPath = iconCandidates.find(candidate => bundle.assetIndex.has(candidate));
            if (assetPath) {
                matched = { bundle, assetPath };
                break;
            }
        }
        if (!matched && plantBundle) {
            const assetPath = getPlantItemAssetCandidates(item)
                .find(candidate => plantBundle.assetIndex.has(candidate));
            if (assetPath) matched = { bundle: plantBundle, assetPath };
        }

        if (!matched) {
            if (useBundledFallback()) return;
            missing.push({ id: itemId, assetName, iconRes });
            return;
        }

        const nativeAsset = resolveNativeAsset(
            matched.bundle.config,
            matched.bundle.sourceUrl,
            cacheList,
            matched.bundle.assetIndex.get(matched.assetPath),
        );
        if (!nativeAsset) {
            if (useBundledFallback()) return;
            missing.push({ id: itemId, assetName, iconRes });
            return;
        }

        const cachedEntry = cacheList.files && cacheList.files[nativeAsset.url];
        const cachedPath = qqFileUrlToPath(cache.gameCachesDir, cachedEntry && cachedEntry.url);
        const ext = path.extname(new URL(nativeAsset.url).pathname) || '.png';
        try {
            const content = await readCachedOrRemote(cache, cacheList, nativeAsset.url);
            writeAtomic(path.join(outputDir, `${itemId}_${displayName}_${tag || 'icon'}${ext}`), content);
            syncedCount++;
            if (cachedPath && fs.existsSync(cachedPath)) cachedCount++;
        } catch (error) {
            errors.push({ id: itemId, error: error.message });
        }
    });

    return { syncedCount, cachedCount, bundledCount, missing, errors };
}

async function syncGameConfigFromQQCache(options = {}) {
    const cache = findLatestQQFarmCache();
    if (!cache) return { skipped: true, reason: '未找到 QQ 农场前台缓存' };

    const cacheList = readJson(cache.cacheListPath);
    const delayBundle = findBundleConfig(cacheList, cache, 'delayRes');
    const plantBundle = findBundleConfig(cacheList, cache, 'plant');
    const extraResBundle = findBundleConfig(cacheList, cache, 'extraRes');
    const itemInfoUrl = resolveJsonAsset(delayBundle.config, delayBundle.sourceUrl, 'config/ItemInfo');
    const plantUrl = resolveJsonAsset(delayBundle.config, delayBundle.sourceUrl, 'config/Plant');

    const outputDir = path.join(getDataDir(), 'gameConfig');
    const itemOutputPath = path.join(outputDir, 'ItemInfo.json');
    const plantOutputPath = path.join(outputDir, 'Plant.json');
    const imageOutputDir = path.join(outputDir, 'seed_images_named');
    const statePath = path.join(outputDir, 'sync-state.json');
    const previousState = fs.existsSync(statePath) ? readJson(statePath) : {};
    const canSkip = !options.force
        && Number(previousState.imageSchemaVersion) === 2
        && previousState.itemInfoUrl === itemInfoUrl
        && previousState.plantUrl === plantUrl
        && previousState.plantBundleUrl === plantBundle.sourceUrl
        && previousState.extraResBundleUrl === extraResBundle.sourceUrl
        && Number(previousState.imageCount) > 0
        && fs.existsSync(itemOutputPath)
        && fs.existsSync(plantOutputPath)
        && fs.existsSync(imageOutputDir);
    if (canSkip) {
        const bundledConfigUpdated = overwriteBundledConfigs(itemOutputPath, plantOutputPath, imageOutputDir);
        return {
            skipped: true,
            reason: bundledConfigUpdated ? 'QQ缓存配置版本未变化，已覆盖内置配置' : 'QQ缓存配置版本未变化',
            bundledConfigUpdated,
            outputDir,
            itemInfoUrl,
            plantUrl,
        };
    }

    const [itemBuffer, plantBuffer] = await Promise.all([
        readCachedOrRemote(cache, cacheList, itemInfoUrl),
        readCachedOrRemote(cache, cacheList, plantUrl),
    ]);
    const officialItems = decodeCocosJsonAsset(JSON.parse(itemBuffer.toString('utf8')), 'ItemInfo');
    const officialPlants = decodeCocosJsonAsset(JSON.parse(plantBuffer.toString('utf8')), 'Plant');
    // Filter out fake/placeholder plant IDs
    var validPlants = officialPlants.filter(function(p) {
        var pid = Number(p && p.id) || 0;
        return pid !== 29999;
    });
    if (officialItems.length < 100) throw new Error(`ItemInfo 数量异常: ${officialItems.length}`);
    if (officialPlants.length < 100) throw new Error(`Plant 数量异常: ${officialPlants.length}`);

    const bundledItems = readJson(getResourcePath('gameConfig', 'ItemInfo.json'));
    const bundledPlants = readJson(getResourcePath('gameConfig', 'Plant.json'));
    const mergedItems = mergeById(bundledItems, officialItems, normalizeItem);
    const mergedPlants = mergeById(bundledPlants, validPlants);
    writeJsonAtomic(itemOutputPath, mergedItems);
    writeJsonAtomic(plantOutputPath, mergedPlants);
    const seedImages = await syncSeedImages(cache, cacheList, plantBundle, mergedItems, imageOutputDir);

    const bundledConfigUpdated = overwriteBundledConfigs(itemOutputPath, plantOutputPath, imageOutputDir);
    const itemImages = await syncOtherItemImages(
        cache,
        cacheList,
        [plantBundle, extraResBundle, delayBundle],
        mergedItems,
        imageOutputDir,
    );
    const images = {
        syncedCount: seedImages.syncedCount + itemImages.syncedCount,
        cachedCount: seedImages.cachedCount + itemImages.cachedCount,
        bundledCount: seedImages.bundledCount + itemImages.bundledCount,
        missing: [...seedImages.missing, ...itemImages.missing],
        errors: [...seedImages.errors, ...itemImages.errors],
        seedCount: seedImages.syncedCount,
        itemCount: itemImages.syncedCount,
    };
    writeJsonAtomic(statePath, {
        imageSchemaVersion: 2,
        itemInfoUrl,
        plantUrl,
        plantBundleUrl: plantBundle.sourceUrl,
        extraResBundleUrl: extraResBundle.sourceUrl,
        officialItemCount: officialItems.length,
        officialPlantCount: validPlants.length,
        mergedItemCount: mergedItems.length,
        mergedPlantCount: mergedPlants.length,
        imageCount: images.syncedCount,
        seedImageCount: images.seedCount,
        itemImageCount: images.itemCount,
        bundledImageCount: images.bundledCount,
        missingImageCount: images.missing.length,
        imageErrorCount: images.errors.length,
        syncedAt: new Date().toISOString(),
    });

    return {
        skipped: false,
        officialItemCount: officialItems.length,
        officialPlantCount: validPlants.length,
        mergedItemCount: mergedItems.length,
        mergedPlantCount: mergedPlants.length,
        addedItemCount: mergedItems.length - bundledItems.length,
        addedPlantCount: mergedPlants.length - bundledPlants.length,
        bundledConfigUpdated,
        imageCount: images.syncedCount,
        seedImageCount: images.seedCount,
        itemImageCount: images.itemCount,
        cachedImageCount: images.cachedCount,
        bundledImageCount: images.bundledCount,
        missingImages: images.missing,
        imageErrors: images.errors,
        outputDir,
        itemInfoUrl,
        plantUrl,
    };
}

module.exports = {
    decodeCocosJsonAsset,
    decompressUuid,
    findLatestQQFarmCache,
    mergeById,
    normalizeItem,
    resolveJsonAsset,
    syncGameConfigFromQQCache,
    syncItemInfoFromQQCache: syncGameConfigFromQQCache,
};
