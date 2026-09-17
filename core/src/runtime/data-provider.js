const { findAccountByRef, normalizeAccountRef, resolveAccountId: resolveAccountIdByList } = require('../services/account-resolver');

const { getSchedulerRegistrySnapshot } = require('../services/scheduler');



function createDataProvider(options) {

    const {

        workers,

        globalLogs,

        accountLogs,

        store,

        getAccounts,

        callWorkerApi,

        buildDefaultStatus,

        normalizeStatusForPanel,

        filterLogs,

        addAccountLog,

        nextConfigRevision,

        broadcastConfigToWorkers,

        startWorker,

        stopWorker,

        restartWorker,
        stealthMode,
    } = options;



    function getStoredAccountsList() {

        const data = getAccounts();

        return Array.isArray(data.accounts) ? data.accounts : [];

    }



    function resolveAccountRefId(accountRef) {

        const raw = normalizeAccountRef(accountRef);

        if (!raw) return '';

        const resolved = resolveAccountIdByList(getStoredAccountsList(), raw);

        return resolved || raw;

    }



    function findAccountByAnyRef(accountRef) {

        return findAccountByRef(getStoredAccountsList(), accountRef);

    }



    return {

        resolveAccountId: (accountRef) => resolveAccountRefId(accountRef),



        // 获取指定账号的状态 (若 accountId 为空，则返回全部)

        getStatus: (accountRef) => {

            const accountId = resolveAccountRefId(accountRef);

            if (!accountId) return buildDefaultStatus('');

            const w = workers[accountId];

            if (!w || !w.status) return buildDefaultStatus(accountId);

            return {

                ...buildDefaultStatus(accountId),

                ...normalizeStatusForPanel(w.status, accountId, w.name),

                wsError: w.wsError || null,

            };

        },



        getLogs: (accountRef, optionsOrLimit) => {

            const opts = (typeof optionsOrLimit === 'object' && optionsOrLimit) ? optionsOrLimit : { limit: optionsOrLimit };

            const max = Math.max(1, Number(opts.limit) || 100);

            const rawRef = normalizeAccountRef(accountRef);

            const accountId = resolveAccountRefId(accountRef);

            // 若未指定账号或指定为 'all'，返回全局日志

            if (!rawRef || rawRef === 'all') {

                return filterLogs(globalLogs, opts).slice(-max);

            }

            if (!accountId) return [];

            const accId = String(accountId || '');

            return filterLogs(globalLogs.filter(l => String(l.accountId || '') === accId), opts).slice(-max);

        },



        getAccountLogs: (limit) => accountLogs.slice(-limit).reverse(),

        addAccountLog: (action, msg, accountId, accountName, extra) => addAccountLog(action, msg, accountId, accountName, extra),



        clearLogs: (accountRef) => {

            const rawRef = normalizeAccountRef(accountRef);

            const accountId = resolveAccountRefId(accountRef);

            

            if (!rawRef || rawRef === 'all') {

                globalLogs.length = 0;

                return { cleared: 'all' };

            }

            

            if (!accountId) return { cleared: 0 };

            

            const accId = String(accountId || '');

            const before = globalLogs.length;

            for (let i = globalLogs.length - 1; i >= 0; i--) {

                if (String(globalLogs[i].accountId || '') === accId) {

                    globalLogs.splice(i, 1);

                }

            }

            const after = globalLogs.length;

            return { cleared: before - after, accountId };

        },



        // 初始化账号状态

        getLands: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getLands'),

        getFriends: (accountRef, forceSync = false) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriends', forceSync),

        clearFriendsCache: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'clearFriendsCache'),

        getInteractRecords: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getInteractRecords'),

        getFriendLands: (accountRef, gid) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriendLands', gid),

        doFriendOp: (accountRef, gid, opType) => callWorkerApi(resolveAccountRefId(accountRef), 'doFriendOp', gid, opType),

        getBag: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getBag'),
        getIllustrated: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getIllustrated'),
        claimIllustrated: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimIllustrated'),
        getWeatherOverview: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getWeatherOverview'),
        buyWeatherBottle: (accountRef, count) => callWorkerApi(resolveAccountRefId(accountRef), 'buyWeatherBottle', [count || 1]),
        useWeatherBottleOnFriend: (accountRef, friendUid) => callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherBottleOnFriend', [friendUid]),
        runWeatherTasksNow: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'runWeatherTasksNow'),
        useWeatherThunderBottle: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherThunderBottle'),
        upgradeWeatherResearch: (accountRef, tierId) => callWorkerApi(resolveAccountRefId(accountRef), 'upgradeWeatherResearch', [tierId]),
        runWeatherResearchNow: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'runWeatherResearchNow'),
        getCharityOverview: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCharityOverview'),
        claimCharityGift: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimCharityGift'),
        sendCharityLove: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'sendCharityLove'),
        claimCharityTier: (accountRef, threshold) => callWorkerApi(resolveAccountRefId(accountRef), 'claimCharityTier', [threshold]),
        shareCharity: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'shareCharity'),
        runCharityTasksNow: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'runCharityTasksNow'),
        getMengchongOverview: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getMengchongOverview'),
        claimMengchongFreeGift: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimMengchongFreeGift'),
        feedMengchongPet: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'feedMengchongPet'),
        autoFeedMengchongPet: (accountRef, opts) => callWorkerApi(resolveAccountRefId(accountRef), 'autoFeedMengchongPet', [opts || {}]),
        getMengchongShop: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getMengchongShop'),
        exchangeMengchongShopGoods: (accountRef, goodsId, count) => callWorkerApi(resolveAccountRefId(accountRef), 'exchangeMengchongShopGoods', goodsId, count),
        claimMengchongBearPet: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimMengchongBearPet'),
        mengchongTreasureHunt: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'mengchongTreasureHunt'),
        getMengchongRules: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getMengchongRules'),
        refreshMengchongWishBags: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'refreshMengchongWishBags'),
        selectMengchongWishBag: (accountRef, key) => callWorkerApi(resolveAccountRefId(accountRef), 'selectMengchongWishBag', key),
        selectMengchongCharm: (accountRef, charmId) => callWorkerApi(resolveAccountRefId(accountRef), 'selectMengchongCharm', charmId),
        unlockMengchongHandnote: (accountRef, handnoteId) => callWorkerApi(resolveAccountRefId(accountRef), 'unlockMengchongHandnote', handnoteId),
        claimMengchongHandnote: (accountRef, handnoteId) => callWorkerApi(resolveAccountRefId(accountRef), 'claimMengchongHandnote', handnoteId),
        mengchongOperate: (accountRef, opts) => callWorkerApi(resolveAccountRefId(accountRef), 'mengchongOperate', [opts || {}]),
        runMengchongTasksNow: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'runMengchongTasksNow'),

        getBagSeeds: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getBagSeeds'),

        useItem: (accountRef, itemId, count) => callWorkerApi(resolveAccountRefId(accountRef), 'useItem', itemId, count),

        sellItems: (accountRef, items) => callWorkerApi(resolveAccountRefId(accountRef), 'sellItems', items),

        getDailyGifts: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getDailyGiftOverview'),

        getSeeds: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getSeeds'),

        buySeed: (accountRef, goodsId, num, price) => callWorkerApi(resolveAccountRefId(accountRef), 'buySeed', goodsId, num, price),

        getMysteryShop: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getMysteryShop'),

        buyMystery: (accountRef, goodsId) => callWorkerApi(resolveAccountRefId(accountRef), 'buyMystery', goodsId),



        setAutomation: async (accountRef, key, value) => {

            const accountId = resolveAccountRefId(accountRef);

            if (!accountId) {

                throw new Error('Missing x-account-id');

            }

            store.setAutomation(key, value, accountId);

            const rev = nextConfigRevision();

            broadcastConfigToWorkers(accountId);

            return { automation: store.getAutomation(accountId), configRevision: rev };

        },



        doFarmOp: (accountRef, opType) => callWorkerApi(resolveAccountRefId(accountRef), 'doFarmOp', opType),

        doAnalytics: (accountRef, sortBy) => callWorkerApi(resolveAccountRefId(accountRef), 'getAnalytics', sortBy),

        buyFertilizer: (accountRef, type, count) => callWorkerApi(resolveAccountRefId(accountRef), 'buyFertilizer', type, count),

        checkAndBuyFertilizer: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'checkAndBuyFertilizer', options),

        saveSettings: async (accountRef, payload) => {

            const accountId = resolveAccountRefId(accountRef);

            if (!accountId) {

                throw new Error('Missing x-account-id');

            }

            const body = (payload && typeof payload === 'object') ? payload : {};

            const plantingStrategy = (body.plantingStrategy !== undefined) ? body.plantingStrategy : body.strategy;

            const preferredSeedId = (body.preferredSeedId !== undefined) ? body.preferredSeedId : body.seedId;

            const snapshot = {

                plantingStrategy,

                preferredSeedId,

                intervals: body.intervals,

                friendQuietHours: body.friendQuietHours,

                stealDelaySeconds: body.stealDelaySeconds,

                plantOrderRandom: body.plantOrderRandom,

                plantDelaySeconds: body.plantDelaySeconds,

                fertilizerBuyOrganicCount: body.fertilizerBuyOrganicCount,

                fertilizerBuyOrganicThresholdHours: body.fertilizerBuyOrganicThresholdHours,

                fertilizerBuyNormalCount: body.fertilizerBuyNormalCount,

                fertilizerBuyNormalThresholdHours: body.fertilizerBuyNormalThresholdHours,

                fertilizerBuyCheckIntervalMinutes: body.fertilizerBuyCheckIntervalMinutes,

                bagSeedPriority: body.bagSeedPriority,

                bagSeedFallbackStrategy: body.bagSeedFallbackStrategy,

                plantSeedExclude: body.plantSeedExclude,

                // 防封号(低调)模式
                stealthEnabled: body.stealthEnabled,
                stealthOnlineMinMinutes: body.stealthOnlineMinMinutes,
                stealthOnlineMaxMinutes: body.stealthOnlineMaxMinutes,
                stealthOfflineMinMinutes: body.stealthOfflineMinMinutes,
                stealthOfflineMaxMinutes: body.stealthOfflineMaxMinutes,
                stealthWakeForRipe: body.stealthWakeForRipe,

                // 夺宝(抢宝)
                robTreasureIntervalMinutes: body.robTreasureIntervalMinutes

            };

            store.applyConfigSnapshot(snapshot, { accountId });

            // 防封号参数变化后立即重排(开启→开始计时; 关闭→清理定时器)
            if (stealthMode && typeof stealthMode.refreshAll === 'function') {
                try { stealthMode.refreshAll(); } catch (e) { /* 忽略 */ }
            }

            const rev = nextConfigRevision();

            broadcastConfigToWorkers(accountId);

            return {

                strategy: store.getPlantingStrategy(accountId),

                preferredSeed: store.getPreferredSeed(accountId),

                intervals: store.getIntervals(accountId),

                friendQuietHours: store.getFriendQuietHours(accountId),

                stealDelaySeconds: store.getStealDelaySeconds(accountId),

                plantOrderRandom: store.getPlantOrderRandom(accountId),

                plantDelaySeconds: store.getPlantDelaySeconds(accountId),

                fertilizerBuyOrganicCount: store.getFertilizerBuyOrganicCount(accountId),

                fertilizerBuyOrganicThresholdHours: store.getFertilizerBuyOrganicThresholdHours(accountId),

                fertilizerBuyNormalCount: store.getFertilizerBuyNormalCount(accountId),

                fertilizerBuyNormalThresholdHours: store.getFertilizerBuyNormalThresholdHours(accountId),

                fertilizerBuyCheckIntervalMinutes: store.getFertilizerBuyCheckIntervalMinutes(accountId),

                bagSeedPriority: store.getBagSeedPriority(accountId),

                bagSeedFallbackStrategy: store.getBagSeedFallbackStrategy(accountId),

                plantSeedExclude: store.getPlantSeedExclude(accountId),

                configRevision: rev,

            };

        },



        setUITheme: async (theme) => {

            const snapshot = store.setUITheme(theme);

            return { ui: snapshot.ui || store.getUI() };

        },



        broadcastConfig: (accountId) => {

            broadcastConfigToWorkers(accountId);

        },



        setRuntimeAccountName: (accountRef, accountName) => {

            const accountId = resolveAccountRefId(accountRef);

            if (!accountId) return;

            const worker = workers[accountId];

            if (worker) {

                worker.name = String(accountName || worker.name || accountId);

            }

        },



        // 账号管理直接操作 store

        getAccounts: () => {

            const data = getAccounts();

            data.accounts.forEach((a) => {

                const worker = workers[a.id];

                a.running = !!worker;

                if (worker && worker.status && worker.status.status && worker.status.status.name) {

                    a.nick = worker.status.status.name;

                }

            });

            return data;

        },



        // ===== 防封号(低调)模式 =====
        getStealthStatus: () => {
            if (!stealthMode) return { enabled: false, accounts: [] };
            const cfg = (typeof store.getStealthConfig === 'function')
                ? store.getStealthConfig()
                : { enabled: false };
            // 为每个账号补一条状态记录(哪怕还没启动过), 前端才能显示该账号的开关与按钮
            try {
                const raw = store.getAccounts ? store.getAccounts() : null;
                const list = Array.isArray(raw) ? raw : ((raw && raw.accounts) || []);
                if (typeof stealthMode.stateOf === 'function') {
                    for (const acc of list) {
                        if (acc && acc.id !== undefined && acc.id !== null) stealthMode.stateOf(String(acc.id));
                    }
                }
            } catch (e) { /* 忽略 */ }
            return {
                enabled: !!cfg.enabled,
                config: cfg,
                accounts: typeof stealthMode.statusList === 'function' ? stealthMode.statusList() : [],
            };
        },

        /** 手动上线/下线一次(action: 'online' | 'offline'), 返回真实执行结果 */
        forceStealth: async (accountRef, action) => {
            if (!stealthMode) return { ok: false, reason: 'stealth_unavailable', message: '防封号模块未就绪' };
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) return { ok: false, reason: 'invalid_account', message: '账号无效' };
            try {
                if (String(action) === 'offline') {
                    const r = await stealthMode.goOffline(accountId, { force: true, manual: true });
                    return { ...(r || { ok: true }), accountId };
                }
                const r = await stealthMode.goOnline(accountId, { force: true, manual: true });
                return { ...(r || { ok: true }), accountId };
            } catch (e) {
                return { ok: false, reason: 'exception', message: e.message, accountId };
            }
        },

        /** 配置变更后重排 */
        refreshStealth: () => {
            if (stealthMode && typeof stealthMode.refreshAll === 'function') stealthMode.refreshAll();
            return { ok: true };
        },

        startAccount: (accountRef) => {

            const accountId = resolveAccountRefId(accountRef);

            const acc = findAccountByAnyRef(accountId || accountRef);

            if (!acc) return false;

            startWorker(acc);

            return true;

        },



        stopAccount: (accountRef) => {

            const accountId = resolveAccountRefId(accountRef);

            const acc = findAccountByAnyRef(accountId || accountRef);

            if (!acc) return false;

            if (accountId) stopWorker(accountId, { reason: '手动停止' });

            return true;

        },



        restartAccount: (accountRef) => {

            const accountId = resolveAccountRefId(accountRef);

            const acc = findAccountByAnyRef(accountId || accountRef);

            if (!acc) return false;

            restartWorker(acc);

            return true;

        },



        isAccountRunning: (accountRef) => {

            const accountId = resolveAccountRefId(accountRef);

            return !!(accountId && workers[accountId]);

        },



        prepareAccountCodeRefresh: async (accountRef) => {

            const accountId = resolveAccountRefId(accountRef);

            const worker = accountId ? workers[accountId] : null;

            const acc = accountId ? findAccountByAnyRef(accountId) : null;

            if (!accountId) return { ok: false, reason: 'invalid_account' };

            if (!worker) {

                // 实例未运行，等待捕获到 code 后 applyCode 启动

                return { ok: true, prepared: false, reason: 'not_running_waiting_code', accountId, accountName: (acc && acc.name) || accountId };

            }

            worker.wsError = { code: 400, message: 'code_refresh_pending', at: Date.now(), waitingCodeRefresh: true };

            try {

                await callWorkerApi(accountId, 'beginCodeRefresh');

            } catch (e) {

                return { ok: false, reason: e && e.message ? e.message : String(e || 'prepare_failed') };

            }

            return { ok: true, accountId };

        },



        refreshAccountCode: async (accountRef, code) => {

            const accountId = resolveAccountRefId(accountRef);

            const acc = findAccountByAnyRef(accountId || accountRef);

            const nextCode = String(code || '').trim();

            if (!acc) return { ok: false, reason: 'account_not_found' };

            if (!nextCode) return { ok: false, reason: 'missing_code' };

            const worker = accountId ? workers[accountId] : null;

            if (!accountId) return { ok: false, reason: 'invalid_account' };

            // 防封号(低调)模式离线期间: 只保存 code, 不自动启动(避免破坏"离线一段时间"的节奏)
            if (stealthMode && typeof stealthMode.isOfflineByStealth === 'function' && stealthMode.isOfflineByStealth(accountId)) {
                store.addOrUpdateAccount({ id: accountId, code: nextCode });
                if (typeof addAccountLog === 'function') {
                    addAccountLog('code_skip', `已获取到 Code，账号处于防封号离线中，暂不启动`, accountId, acc.name, { reason: 'stealth_offline' });
                }
                return { ok: true, skipped: 'stealth_offline', reason: 'stealth_offline', accountId };
            }

            if (!worker) {

                // 实例未运行，使用新 Code 直接启动

                store.addOrUpdateAccount({ id: accountId, code: nextCode });

                const started = startWorker({ ...acc, id: accountId, code: nextCode }, { codeRefresh: true });

                if (!started) return { ok: false, reason: 'start_failed' };

                addAccountLog('code_start', `已获取到 Code，直接启动账号 ${nextCode.substring(0, 8)}...`, accountId, acc.name, { reason: 'code_capture_start' });

                return { ok: true, started: true, reason: 'code_capture_start', accountId, accountName: acc.name };

            }

            store.addOrUpdateAccount({ id: accountId, code: nextCode });

            // 防封号(低调)模式: 当前会话健康时, 取码只更新 code, 不重启 worker
            // (否则每取一次码就重启一次, 会不断重置"在线计时", 导致永远走不到离线阶段)
            const waitingForCode = !!(worker.wsError && worker.wsError.waitingCodeRefresh);
            const stealthOn = (() => {
                try { return !!store.getStealthConfig(accountId).enabled; } catch (e) { return false; }
            })();
            if (stealthOn && !waitingForCode) {
                addAccountLog('code_keep', `防封号模式: 已更新 Code, 不打断当前在线会话(${nextCode.substring(0, 8)}...)`, accountId, acc.name, { reason: 'stealth_keep_running' });
                return { ok: true, skipped: 'stealth_keep_running', reason: 'stealth_keep_running', accountId };
            }

            const directRestartReason = waitingForCode ? 'kickout_waiting_code_refresh' : 'code_refresh_restart';

            if (typeof restartWorker !== 'function') return { ok: false, reason: directRestartReason };

            restartWorker({ ...acc, id: accountId, code: nextCode }, { preserveStartedAt: true, codeRefresh: true });

            addAccountLog('code_restart', `已获取到 Code，重新登录账号 ${nextCode.substring(0, 8)}...`, accountId, acc.name, { reason: directRestartReason });

            return { ok: true, restarted: true, reason: directRestartReason, accountId, accountName: acc.name };

        },



        // 继承链

        getMallCatalog: (accountRef, slotType) => callWorkerApi(resolveAccountRefId(accountRef), 'getMallCatalog', { slotType }),

        purchaseMallGoods: (accountRef, goodsId, count, slotType, source, shopId) => callWorkerApi(resolveAccountRefId(accountRef), 'purchaseMallGoods', goodsId, count, slotType, source, shopId),



        // 获取链

        activateDog: (accountRef, dogTypeId) => callWorkerApi(resolveAccountRefId(accountRef), 'activateDog', dogTypeId),

        feedDog: (accountRef, itemId, count) => callWorkerApi(resolveAccountRefId(accountRef), 'feedDog', itemId, count),

        getDogStatus: (accountRef, friendGid) => callWorkerApi(resolveAccountRefId(accountRef), 'getDogStatus', friendGid),

        getDogFoodList: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getDogFoodList'),

        getPetList: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getPetList'),

        deployDog: (accountRef, dogTypeId) => callWorkerApi(resolveAccountRefId(accountRef), 'deployDog', dogTypeId),

        withdrawDog: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'withdrawDog'),

        getPetBagInfo: (accountRef, friendGid) => callWorkerApi(resolveAccountRefId(accountRef), 'getPetBagInfo', friendGid),

        getGuardLogs: (accountRef, page, pageSize) => callWorkerApi(resolveAccountRefId(accountRef), 'getGuardLogs', page, pageSize),

        getGuardReward: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getGuardReward'),

        claimGuardReward: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimGuardReward'),

        getCapitalMode: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCapitalMode'),

        setCapitalMode: (accountRef, config) => callWorkerApi(resolveAccountRefId(accountRef), 'setCapitalMode', config),

        getActivityOverview: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'getActivityOverview', options),

        drawActivityLottery: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'drawActivityLottery', options),

        drawActivity: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'drawActivity', options),

        sellQingniangBrew: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'sellQingniangBrew', options),

        shareSellQingniangBrew: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'shareSellQingniangBrew', options),

        performQingniangBrew: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'performQingniangBrew', options),



        claimActivityBattlePass: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'claimActivityBattlePass', options),

        claimActivityTasks: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'claimActivityTasks', options),

        claimActivityDailySignin: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'claimActivityDailySignin', options),

        exchangeActivityGoods: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'exchangeActivityGoods', options),

        getStarActivity: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getStarActivity'),

        exchangeStarGoods: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'exchangeStarGoods', options),

        lightUpStar: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'lightUpStar', options),

        // ===== 夺宝(抢宝) =====
        getTreasureBooks: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getTreasureBooks'),
        getTreasureTargets: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'getTreasureTargets', options || {}),
        getTreasureMyStatus: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getTreasureMyStatus'),
        robTreasure: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'robTreasure', options || {}),
        runTreasureRobNow: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'runTreasureRobNow', options || {}),

        getSolarTerms: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getSolarTerms'),

        claimSolarTerms: (accountRef, termId) => callWorkerApi(resolveAccountRefId(accountRef), 'claimSolarTerms', termId),





        getSchedulerStatus: async (accountRef) => {

            const accountId = resolveAccountRefId(accountRef);

            const runtime = getSchedulerRegistrySnapshot();

            let worker = null;

            let workerError = '';



            if (!accountId) {

                return { accountId: '', runtime, worker, workerError };

            }



            if (!workers[accountId]) {

                return { accountId, runtime, worker, workerError: '账号未运行' };

            }



            try {

                worker = await callWorkerApi(accountId, 'getSchedulers');

            } catch (e) {

                workerError = (e && e.message) ? e.message : String(e || 'unknown');

            }

            return { accountId, runtime, worker, workerError };

        },

    };

}



module.exports = {

    createDataProvider,

};

