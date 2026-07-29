// ==UserScript==
// @name         B站关注功能优化
// @namespace    https://github.com/habixz
// @version      1.4.0
// @description  接管 B 站关注与设置分组入口，统一使用更好用的自定义分组面板。
// @author       habixz
// @match        https://*.bilibili.com/*
// @match        https://bilibili.com/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// @note         修改维护：habixz
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_NAME = 'B站关注功能优化';
    const SCRIPT_KEY = '__biliFollowFeatureOptimizerRuntime__';

    /**
     * 统一维护本脚本所需的接口地址。
     * 这样后续如果 B 站更换了某个接口，只需要改这里即可。
     */
    const API = {
        relationTags: 'https://api.bilibili.com/x/relation/tags',
        relationTagUser: 'https://api.bilibili.com/x/relation/tag/user',
        setUserSubscribeGroup: 'https://api.bilibili.com/x/relation/tags/addUsers',
        modifyRelation: 'https://api.bilibili.com/x/relation/modify'
    };

    /**
     * 把常用选择器集中起来，避免业务逻辑里散落一堆选择器字符串。
     * 这些选择器尽量使用业务类名，不依赖 data-v 之类的构建产物标记。
     */
    const SELECTORS = {
        pageRoot: '.space-follow',
        followMain: '.follow-main',
        batchModeEnterButton: '.follow-main-title-batch',
        batchHeader: '.relation-content-header',
        batchHeaderRight: '.relation-content-header__right',
        originalCopyButton: '.relation-content-header__right .action-btn',
        selectedCardCheckbox: '.relation-card > label.vui_checkbox--checked',
        relationCard: '.relation-card',
        relationCardAvatar: '.relation-card-avatar[data-user-profile-id], .relation-card-avatar[href*="space.bilibili.com/"]',
        selectedCount: '.relation-content-header__left .selected',
        nativeFollowButton: '.follow-btn, .already-btn, .fans-action-btn, .follow_dropdown li, .follow-ctnr, .h-f-btn, .not-follow, .following',
        nativeFollowTrigger: '[data-mid], [data-vmid], [data-user-id], [data-user-mid], [data-user-profile-id], [href*="space.bilibili.com/"], [href*="mid"]',
        videoUpInfoContainer: '.up-info-container',
        videoUpNameLink: '.up-info-container a.up-name[href*="space.bilibili.com/"]',
        videoUpAvatarLink: '.up-info-container a.up-avatar[href*="space.bilibili.com/"]',
        videoSendMsgLink: '.up-info-container a.send-msg[href*="mid"]',
        liveFollowContainer: '.follow-ctnr',
        liveAnchorContainer: '#head-info-vm .left-anchor-section',
        spaceHeaderFollowButton: '.space-head-follow .follow-btn',
        spaceHeaderContainer: '.space-header .upinfo.header-upinfo',
        followCardButton: '.relation-card .relation-card-info-option .follow-btn',
        followCardContainer: '.relation-card'
    };

    /**
     * 自定义节点使用固定类名前缀，避免污染原页面样式。
     */
    const CLASS_NAMES = {
        style: 'bfpo-style',
        actionGroup: 'bfpo-action-group',
        actionButton: 'bfpo-action-button',
        actionButtonDanger: 'bfpo-action-button-danger',
        toastRoot: 'bfpo-toast-root',
        toast: 'bfpo-toast',
        overlay: 'bfpo-overlay',
        dialog: 'bfpo-dialog',
        dialogTitle: 'bfpo-dialog-title',
        dialogDesc: 'bfpo-dialog-desc',
        dialogList: 'bfpo-dialog-list',
        dialogItem: 'bfpo-dialog-item',
        dialogItemContent: 'bfpo-dialog-item-content',
        dialogItemMain: 'bfpo-dialog-item-main',
        dialogItemSubnote: 'bfpo-dialog-item-subnote',
        dialogItemWarning: 'bfpo-dialog-item-warning',
        dialogItemDefault: 'bfpo-dialog-item-default',
        dialogItemDefaultInactive: 'bfpo-dialog-item-default-inactive',
        dialogItemCheckbox: 'bfpo-dialog-item-checkbox',
        dialogFooter: 'bfpo-dialog-footer',
        dialogButton: 'bfpo-dialog-button',
        dialogButtonPrimary: 'bfpo-dialog-button-primary',
        dialogButtonDanger: 'bfpo-dialog-button-danger',
        dialogEmpty: 'bfpo-dialog-empty',
        dialogLoading: 'bfpo-dialog-loading',
        managedFollowButton: 'bfpo-managed-follow-button'
    };

    /**
     * 一些和节奏、提示相关的常量。
     * 批量取消关注容易触发连续请求，因此这里做了适度的并发限制与间隔控制。
     */
    const CONFIG = {
        observerDebounce: 120,
        routeCheckInterval: 700,
        toastDuration: 2200,
        unfollowConcurrency: 3,
        requestGap: 180
    };
    const DEFAULT_GROUP_TAG_ID = 0;

    /**
     * 运行期状态集中放在这里，避免隐式全局变量。
     */
    const state = {
        currentUrl: location.href,
        routeTimer: 0,
        mutationTimer: 0,
        pageObserver: null,
        toastTimer: 0,
        toastRoot: null,
        groupOptionsCache: null,
        groupOptionsCacheAt: 0,
        singleUserGroupCache: new Map(),
        managedFollowButtons: new Map(),
        activeOverlay: null,
        overlayStack: [],
        busy: false,
        scrollLockCount: 0,
        previousBodyOverflow: '',
        previousHtmlOverflow: ''
    };

    /**
     * 使用脚本级运行时句柄保证幂等。
     * 如果脚本热更新或重复注入，旧实例会先清理，避免出现双重监听。
     */
    const runtime = window[SCRIPT_KEY] || (window[SCRIPT_KEY] = {});
    if (typeof runtime.destroy === 'function') {
        runtime.destroy();
    }
    runtime.destroy = destroy;

    bootstrap();

    /**
     * 脚本启动入口。
     * 这里只做一次性的初始化，把真正的页面逻辑交给后续调度。
     */
    function bootstrap() {
        installStyle();
        observePage();
        bindInteractionListeners();
        startRouteWatcher();
        handlePageChange();
    }

    /**
     * 绑定轻量交互监听。
     * 批量模式里勾选/取消勾选通常只是类名和表单状态变化，不一定会触发子节点增删，
     * 所以这里额外监听点击与 change 事件，确保自定义按钮的可用状态能及时刷新。
     */
    function bindInteractionListeners() {
        document.addEventListener('click', handleDocumentInteraction, true);
        document.addEventListener('change', handleDocumentInteraction, true);
    }

    /**
     * 在批量操作相关交互发生后，轻量刷新一次按钮状态。
     *
     * @param {Event} event
     */
    function handleDocumentInteraction(event) {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        if (handleGlobalFollowEntryClick(event, target)) {
            return;
        }

        if (!isFollowPage()) {
            return;
        }

        if (
            !target.closest(SELECTORS.batchHeader)
            && !target.closest(SELECTORS.relationCard)
            && !target.closest(SELECTORS.batchModeEnterButton)
        ) {
            return;
        }

        window.setTimeout(() => {
            injectBatchButtons();
        }, 0);
    }

    /**
     * 判断当前页面是否是 B 站个人空间的关注页。
     * 这样脚本就算被匹配到其他 relation 子页面，也不会误运行。
     *
     * @returns {boolean}
     */
    function isFollowPage() {
        return location.hostname === 'space.bilibili.com' && /\/relation\/follow/.test(location.pathname);
    }

    /**
     * 监听 URL 变化。
     * B 站空间页经常走前端路由，因此不能只依赖一次性的页面加载。
     */
    function startRouteWatcher() {
        state.routeTimer = window.setInterval(() => {
            if (state.currentUrl === location.href) {
                return;
            }
            state.currentUrl = location.href;
            handlePageChange();
        }, CONFIG.routeCheckInterval);
    }

    /**
     * 监听 DOM 变化。
     * 批量操作头部、关注列表、左侧分组列表都是异步渲染出来的，因此需要在局部变化后重试挂载。
     */
    function observePage() {
        if (state.pageObserver) {
            state.pageObserver.disconnect();
        }

        state.pageObserver = new MutationObserver((mutationList) => {
            if (!shouldHandleFollowPageMutation(mutationList)) {
                return;
            }

            window.clearTimeout(state.mutationTimer);
            state.mutationTimer = window.setTimeout(() => {
                if (isFollowPage()) {
                    injectBatchButtons();
                    return;
                }
                syncManagedFollowButtons();
            }, CONFIG.observerDebounce);
        });

        if (document.body) {
            state.pageObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
        }
    }

    /**
     * 页面切换后的统一处理入口。
     * 这里主动触发一次展开分组与按钮注入，避免完全依赖 MutationObserver。
     */
    function handlePageChange() {
        closeAllOverlays();
        state.singleUserGroupCache.clear();
        if (isFollowPage()) {
            injectBatchButtons();
            return;
        }
        syncManagedFollowButtons();
    }

    /**
     * 判断某一批 DOM 变更是否和关注页功能相关。
     * 这里不再对 document.body 上的所有子树变化都响应，只处理和关注页主体相关的节点。
     *
     * @param {MutationRecord[]} mutationList
     * @returns {boolean}
     */
    function shouldHandleFollowPageMutation(mutationList) {
        if (isFollowPage()) {
            return mutationList.some((record) => {
                if (isRelevantFollowPageNode(record.target)) {
                    return true;
                }

                return Array.from(record.addedNodes).some(isRelevantFollowPageNode)
                    || Array.from(record.removedNodes).some(isRelevantFollowPageNode);
            });
        }

        return mutationList.some((record) => {
            if (isRelevantManagedFollowNode(record.target)) {
                return true;
            }

            return Array.from(record.addedNodes).some(isRelevantManagedFollowNode)
                || Array.from(record.removedNodes).some(isRelevantManagedFollowNode);
        });
    }

    /**
     * 判断某个节点是否位于关注页主体内，或本身/后代就是关注页主体节点。
     * 这样可以过滤掉页面其他无关区域的 DOM 波动。
     *
     * @param {Node} node
     * @returns {boolean}
     */
    function isRelevantFollowPageNode(node) {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!(element instanceof Element)) {
            return false;
        }

        if (
            element.matches(SELECTORS.pageRoot)
            || element.matches(SELECTORS.followMain)
            || Boolean(element.closest(SELECTORS.pageRoot))
        ) {
            return true;
        }

        return Boolean(
            element.querySelector(SELECTORS.pageRoot)
            || element.querySelector(SELECTORS.followMain)
        );
    }

    /**
     * 判断某个节点是否和“站内关注按钮镜像”有关。
     * 这里不靠固定页面路径，而是看新增/变化节点里是否包含关注按钮或其关键容器。
     *
     * @param {Node} node
     * @returns {boolean}
     */
    function isRelevantManagedFollowNode(node) {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!(element instanceof Element)) {
            return false;
        }

        if (element.closest(`.${CLASS_NAMES.managedFollowButton}`)) {
            return false;
        }

        if (
            element.matches('.follow-btn, .already-btn, .fans-action-btn, .follow-ctnr, .up-info-container, .space-head-follow')
            || Boolean(element.closest('.follow-btn, .already-btn, .fans-action-btn, .follow-ctnr, .up-info-container, .space-head-follow'))
        ) {
            return true;
        }

        return Boolean(element.querySelector('.follow-btn, .already-btn, .fans-action-btn, .follow-ctnr, .up-info-container, .space-head-follow'));
    }

    /**
     * 处理全站范围内的“关注 / 设置分组”入口点击。
     * 这里的目标是：
     * 1. 未关注时点击“关注”，不直接走原生关注，而是先弹我们的分组面板
     * 2. 已关注时点击“设置分组”，不再打开原生分组面板，而是改用我们的面板
     *
     * @param {Event} event
     * @param {Element} target
     * @returns {boolean}
     */
    function handleGlobalFollowEntryClick(event, target) {
        if (target.closest(`.${CLASS_NAMES.overlay}`)) {
            return false;
        }

        if (target.closest(`.${CLASS_NAMES.managedFollowButton}`)) {
            return false;
        }

        const trigger = findFollowActionTrigger(target);
        if (!(trigger instanceof HTMLElement)) {
            return false;
        }

        if (isFollowPage() && target.closest(SELECTORS.batchHeader)) {
            return false;
        }

        const actionType = inferManagedFollowButtonAction(trigger);
        if (!actionType) {
            return false;
        }

        const uid = extractUidFromActionTrigger(trigger);
        if (!Number.isFinite(uid)) {
            return false;
        }

        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
        }

        window.setTimeout(() => {
            if (actionType === 'follow') {
                void openSingleUserFollowDialog(uid);
                return;
            }

            void openSingleUserSetGroupDialog(uid);
        }, 0);

        return true;
    }

    /**
     * 从当前点击位置往上寻找最合适的关注入口节点。
     *
     * @param {Element} target
     * @returns {HTMLElement | null}
     */
    function findFollowActionTrigger(target) {
        let current = target;
        while (current instanceof HTMLElement) {
            if (isPotentialFollowButton(current)) {
                return current;
            }
            current = current.parentElement;
        }

        return null;
    }

    /**
     * 判断某个节点是否像一个“关注相关按钮”。
     * 这里先用标签/类名/文本做宽松识别，后面再结合文案判断动作类型。
     *
     * @param {HTMLElement} element
     * @returns {boolean}
     */
    function isPotentialFollowButton(element) {
        /**
         * 这里不能再用“只要在 UP 信息区里、文本又带关注字样”这种宽松判断，
         * 因为视频页 `.up-info-container` 会把头像、UP 名、发消息等元素都包进去，
         * 一旦沿祖先链向上匹配到整块容器，就会把这些普通入口误拦截成“打开关注面板”。
         *
         * 因此这里改成两层限制：
         * 1. 当前节点本身是原生关注控件，或位于原生关注控件内部
         * 2. 文本语义确实是“关注 / 设置分组”
         */
        const actionRoot = getNativeFollowActionRoot(element);
        if (!(actionRoot instanceof HTMLElement)) {
            return false;
        }

        const text = normalizeText(actionRoot.textContent);
        if (!text) {
            return false;
        }

        if (!/(关注|设置分组)/.test(text)) {
            return false;
        }

        return true;
    }

    /**
     * 找到当前节点所属的原生“关注动作控件根节点”。
     * 只允许落在真实关注控件内部的点击继续向下处理，
     * 这样视频页里的头像、UP 名、发消息就不会再被误识别。
     *
     * @param {HTMLElement} element
     * @returns {HTMLElement | null}
     */
    function getNativeFollowActionRoot(element) {
        if (element.matches(SELECTORS.nativeFollowButton)) {
            return element;
        }

        return element.closest(SELECTORS.nativeFollowButton);
    }

    /**
     * 依据按钮文案判断动作类型。
     * 这里只拦两种：
     * - 未关注的“关注”
     * - 已关注后的“设置分组”
     *
     * @param {HTMLElement} trigger
     * @returns {'follow' | 'set_group' | ''}
     */
    function inferFollowActionType(trigger) {
        const text = normalizeText(trigger.textContent);
        if (!text) {
            return '';
        }

        if (text.includes('设置分组')) {
            return 'set_group';
        }

        if (
            text.includes('关注')
            && !text.includes('已关注')
            && !text.includes('互粉')
            && !text.includes('取消关注')
            && !text.includes('设置分组')
        ) {
            return 'follow';
        }

        return '';
    }

    /**
     * 同步站内“关注相关按钮”的镜像节点。
     * 这里的核心思路不是硬写样式，而是直接克隆原生按钮节点作为外观模板，
     * 然后把点击行为换成我们自己的逻辑。
     */
    function syncManagedFollowButtons() {
        cleanupManagedFollowButtons();

        const originalButtons = collectManagedFollowCandidates();
        const candidateSet = new Set(originalButtons);

        Array.from(state.managedFollowButtons.keys()).forEach((originalButton) => {
            if (!candidateSet.has(originalButton)) {
                restoreManagedFollowButton(originalButton);
            }
        });

        originalButtons.forEach((originalButton) => {
            if (!(originalButton instanceof HTMLElement)) {
                return;
            }

            if (!shouldManageNativeFollowButton(originalButton)) {
                restoreManagedFollowButton(originalButton);
                return;
            }

            mountManagedFollowButton(originalButton);
        });
    }

    /**
     * 收集所有可能需要接管的原生关注入口。
     * 不再依赖一个泛化的 `.follow-btn`，而是按场景收集：
     * - 视频页 UP 卡片
     * - 直播页顶部关注按钮
     * - 个人主页头部关注按钮
     * - 关注页卡片里的已关注按钮
     *
     * @returns {HTMLElement[]}
     */
    function collectManagedFollowCandidates() {
        const candidatesByScope = new Map();

        [
            ...document.querySelectorAll('.up-info__btn-panel .follow-btn'),
            ...document.querySelectorAll(SELECTORS.liveFollowContainer),
            ...document.querySelectorAll(SELECTORS.spaceHeaderFollowButton),
            ...document.querySelectorAll(SELECTORS.followCardButton)
        ].forEach((node) => {
            if (!(node instanceof HTMLElement) || node.classList.contains(CLASS_NAMES.managedFollowButton)) {
                return;
            }

            const scopeKey = getManagedFollowCandidateScopeKey(node);
            const previousNode = candidatesByScope.get(scopeKey);
            candidatesByScope.set(
                scopeKey,
                choosePreferredManagedFollowCandidate(previousNode, node)
            );
        });

        return Array.from(candidatesByScope.values());
    }

    /**
     * 生成关注按钮候选节点所属“作用域”的唯一键。
     * 同一块业务区域里如果因为站内重渲染暂时存在两个原生关注按钮，
     * 这里会把它们折叠成同一个作用域，后续只保留一个进行接管。
     *
     * @param {HTMLElement} button
     * @returns {string}
     */
    function getManagedFollowCandidateScopeKey(button) {
        const scopeRoot = button.closest([
            SELECTORS.followCardContainer,
            SELECTORS.videoUpInfoContainer,
            SELECTORS.liveAnchorContainer,
            SELECTORS.spaceHeaderContainer
        ].join(','));

        const uid = extractUidFromActionTrigger(button);
        const scopeIdentity = scopeRoot instanceof HTMLElement
            ? buildElementScopePath(scopeRoot)
            : buildElementScopePath(button.parentElement || button);

        return `${scopeIdentity}::${Number.isFinite(uid) ? uid : 'unknown'}`;
    }

    /**
     * 在同一作用域内挑一个更适合接管的原生按钮。
     * 优先级如下：
     * 1. 优先保留不是脚本旧隐藏节点的按钮；
     * 2. 如果两者条件相同，保留文档顺序更靠后的那个，
     *    因为站内重渲染时新节点通常会出现在旧节点之后。
     *
     * @param {HTMLElement | undefined} previousButton
     * @param {HTMLElement} nextButton
     * @returns {HTMLElement}
     */
    function choosePreferredManagedFollowCandidate(previousButton, nextButton) {
        if (!(previousButton instanceof HTMLElement)) {
            return nextButton;
        }

        const previousHiddenByScript = previousButton.dataset.bfpoManagedHidden === 'true';
        const nextHiddenByScript = nextButton.dataset.bfpoManagedHidden === 'true';
        if (previousHiddenByScript !== nextHiddenByScript) {
            return previousHiddenByScript ? nextButton : previousButton;
        }

        const position = previousButton.compareDocumentPosition(nextButton);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
            return nextButton;
        }

        return previousButton;
    }

    /**
     * 为一个节点生成足够稳定的作用域路径。
     * 这里不依赖随机属性，而是用节点在父层级中的位置来构造，
     * 便于在同一页面内区分不同的关注按钮容器。
     *
     * @param {Element} element
     * @returns {string}
     */
    function buildElementScopePath(element) {
        const segments = [];
        let current = element;
        let depth = 0;

        while (current instanceof Element && depth < 5) {
            const parent = current.parentElement;
            const index = parent
                ? Array.from(parent.children).indexOf(current)
                : 0;
            segments.push(`${current.tagName}.${current.className || ''}:${index}`);
            current = parent;
            depth += 1;
        }

        return segments.join('>');
    }

    /**
     * 判断一个原生关注按钮是否应该交给脚本接管。
     *
     * @param {HTMLElement} originalButton
     * @returns {boolean}
     */
    function shouldManageNativeFollowButton(originalButton) {
        if (originalButton.classList.contains(CLASS_NAMES.managedFollowButton)) {
            return false;
        }

        if (originalButton.closest(`.${CLASS_NAMES.overlay}`)) {
            return false;
        }

        if (isFollowPage() && originalButton.closest(SELECTORS.pageRoot) && !originalButton.closest(SELECTORS.followCardContainer)) {
            return false;
        }

        const actionType = inferManagedFollowButtonAction(originalButton);
        if (!actionType) {
            return false;
        }

        const uid = extractUidFromActionTrigger(originalButton);
        return Number.isFinite(uid);
    }

    /**
     * 判断一个原生关注按钮当前对应的动作语义。
     * 这里只区分两种：
     * - `follow`：未关注，点击后进入“先选分组再关注”
     * - `set_group`：已关注，点击后进入“设置分组”
     *
     * @param {HTMLElement} originalButton
     * @returns {'follow' | 'set_group' | ''}
     */
    function inferManagedFollowButtonAction(originalButton) {
        const text = normalizeText(originalButton.textContent);
        if (originalButton.matches(SELECTORS.liveFollowContainer)) {
            const buttonStrategy = normalizeText(originalButton.dataset.curbuttonstrategy);
            if (buttonStrategy.includes('关注')) {
                return 'follow';
            }

            const liveText = normalizeText(originalButton.textContent);
            if (liveText.includes('已关注') || liveText.includes('取消关注')) {
                return 'set_group';
            }
        }

        if (!text) {
            return '';
        }

        if (
            originalButton.classList.contains('following')
            || text.includes('已关注')
            || text.includes('互粉')
            || text.includes('设置分组')
        ) {
            return 'set_group';
        }

        if (text.includes('关注') && !text.includes('取消关注')) {
            return 'follow';
        }

        return '';
    }

    /**
     * 把原生关注按钮替换成我们自己的镜像按钮。
     * 镜像按钮直接克隆原生节点，所以位置、尺寸、颜色、圆角等都跟原生走。
     *
     * @param {HTMLElement} originalButton
     */
    function mountManagedFollowButton(originalButton) {
        const actionType = inferManagedFollowButtonAction(originalButton);
        const uid = extractUidFromActionTrigger(originalButton);
        if (!actionType || !Number.isFinite(uid)) {
            restoreManagedFollowButton(originalButton);
            return;
        }

        const fingerprint = `${actionType}::${uid}::${normalizeText(originalButton.textContent)}::${originalButton.className}`;
        const currentRecord = state.managedFollowButtons.get(originalButton);
        if (
            currentRecord
            && currentRecord.mirror.isConnected
            && currentRecord.fingerprint === fingerprint
        ) {
            return;
        }

        restoreManagedFollowButton(originalButton);

        const mirrorButton = buildManagedFollowButtonMirror(originalButton, actionType, uid);
        originalButton.dataset.bfpoManagedHidden = 'true';
        originalButton.style.display = 'none';
        originalButton.insertAdjacentElement('afterend', mirrorButton);

        state.managedFollowButtons.set(originalButton, {
            mirror: mirrorButton,
            fingerprint
        });
    }

    /**
     * 创建镜像按钮。
     * 这里深拷贝原生按钮 DOM，再清理掉原生的菜单浮层，避免把站内行为一并复制过来。
     *
     * @param {HTMLElement} originalButton
     * @param {'follow' | 'set_group'} actionType
     * @param {number} uid
     * @returns {HTMLElement}
     */
    function buildManagedFollowButtonMirror(originalButton, actionType, uid) {
        const mirrorButton = originalButton.cloneNode(true);
        if (!(mirrorButton instanceof HTMLElement)) {
            return document.createElement('div');
        }

        mirrorButton.classList.add(CLASS_NAMES.managedFollowButton);
        mirrorButton.removeAttribute('id');
        mirrorButton.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
        mirrorButton.querySelectorAll('.van-popover, .follow_dropdown').forEach((node) => node.remove());
        stripManagedFollowPopoverHooks(mirrorButton);
        mirrorButton.dataset.bfpoManagedAction = actionType;
        mirrorButton.dataset.bfpoManagedUid = String(uid);

        mirrorButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }

            if (state.busy) {
                return;
            }

            if (actionType === 'follow') {
                void openSingleUserFollowDialog(uid);
                return;
            }

            void openSingleUserSetGroupDialog(uid);
        });

        return mirrorButton;
    }

    /**
     * 清理镜像按钮里残留的原生悬浮菜单触发钩子。
     * 这里仅保留和原生弹层触发直接相关的属性/类，避免误伤按钮本身的视觉样式。
     *
     * @param {HTMLElement} mirrorButton
     */
    function stripManagedFollowPopoverHooks(mirrorButton) {
        const triggerLikeNodes = [mirrorButton, ...mirrorButton.querySelectorAll('*')];
        triggerLikeNodes.forEach((node) => {
            if (!(node instanceof HTMLElement)) {
                return;
            }

            node.classList.remove(
                'menu-popover',
                'van-popover__reference'
            );
            node.removeAttribute('aria-describedby');
            node.removeAttribute('aria-controls');
            node.removeAttribute('aria-expanded');
            node.removeAttribute('data-vv-popover-ref');
            node.removeAttribute('data-curbutton');
            node.removeAttribute('data-curbuttonstrategy');
        });
    }

    /**
     * 清理已经失效的镜像按钮记录。
     * 当原生节点被页面卸载时，对应的镜像也应该一起移除。
     */
    function cleanupManagedFollowButtons() {
        Array.from(state.managedFollowButtons.entries()).forEach(([originalButton]) => {
            if (originalButton.isConnected) {
                return;
            }

            restoreManagedFollowButton(originalButton);
        });
    }

    /**
     * 恢复一个原生关注按钮，并移除脚本生成的镜像按钮。
     *
     * @param {HTMLElement} originalButton
     */
    function restoreManagedFollowButton(originalButton) {
        const record = state.managedFollowButtons.get(originalButton);
        if (record?.mirror instanceof HTMLElement && record.mirror.isConnected) {
            record.mirror.remove();
        }

        if (originalButton instanceof HTMLElement && originalButton.dataset.bfpoManagedHidden === 'true') {
            originalButton.style.display = '';
            delete originalButton.dataset.bfpoManagedHidden;
        }

        state.managedFollowButtons.delete(originalButton);
    }

    /**
     * 从关注入口附近提取目标 UID。
     * 优先读取 data-*，其次从附近链接中解析 `space.bilibili.com/{uid}`。
     *
     * @param {HTMLElement} trigger
     * @returns {number}
     */
    function extractUidFromActionTrigger(trigger) {
        const contextualUid = extractUidFromKnownPageContext(trigger);
        if (Number.isFinite(contextualUid)) {
            return contextualUid;
        }

        const elementChain = [trigger, ...getClosestActionContextCandidates(trigger)];
        for (const element of elementChain) {
            if (!(element instanceof HTMLElement)) {
                continue;
            }

            const datasetUid = firstFiniteNumber([
                element.dataset.mid,
                element.dataset.vmid,
                element.dataset.userId,
                element.dataset.userMid,
                element.dataset.userProfileId
            ]);
            if (Number.isFinite(datasetUid)) {
                return datasetUid;
            }

            const selfHrefUid = extractUidFromHref(element.getAttribute('href'));
            if (Number.isFinite(selfHrefUid)) {
                return selfHrefUid;
            }

            const relatedNode = element.querySelector(SELECTORS.nativeFollowTrigger);
            if (relatedNode instanceof HTMLElement) {
                const relatedDatasetUid = firstFiniteNumber([
                    relatedNode.dataset.mid,
                    relatedNode.dataset.vmid,
                    relatedNode.dataset.userId,
                    relatedNode.dataset.userMid,
                    relatedNode.dataset.userProfileId
                ]);
                if (Number.isFinite(relatedDatasetUid)) {
                    return relatedDatasetUid;
                }

                const relatedHrefUid = extractUidFromHref(relatedNode.getAttribute('href'));
                if (Number.isFinite(relatedHrefUid)) {
                    return relatedHrefUid;
                }
            }
        }

        return NaN;
    }

    /**
     * 从已知页面上下文里直接提取 UID。
     * 当前最重要的是视频页右侧 UP 卡片，这里的 UID 线索最稳定。
     *
     * @param {HTMLElement} trigger
     * @returns {number}
     */
    function extractUidFromKnownPageContext(trigger) {
        if (trigger.closest(SELECTORS.videoUpInfoContainer)) {
            const initialStateUid = Number(window.__INITIAL_STATE__?.videoData?.owner?.mid);
            if (Number.isFinite(initialStateUid)) {
                return initialStateUid;
            }

            const hrefUid = firstFiniteNumber([
                extractUidFromHref(document.querySelector(SELECTORS.videoUpNameLink)?.getAttribute('href') || ''),
                extractUidFromHref(document.querySelector(SELECTORS.videoUpAvatarLink)?.getAttribute('href') || ''),
                extractUidFromHref(document.querySelector(SELECTORS.videoSendMsgLink)?.getAttribute('href') || '')
            ]);
            if (Number.isFinite(hrefUid)) {
                return hrefUid;
            }
        }

        if (trigger.closest(SELECTORS.liveAnchorContainer)) {
            const liveUid = firstFiniteNumber([
                window.__NEPTUNE_IS_MY_WAIFU__?.roomInitRes?.data?.uid,
                window.__NEPTUNE_IS_MY_WAIFU__?.roomInfoRes?.data?.anchor_info?.base_info?.uid,
                window.__STORE__?.baseInfoRoom?.anchor_uid
            ]);
            if (Number.isFinite(liveUid)) {
                return liveUid;
            }

            const liveHrefUid = firstFiniteNumber(Array.from(document.querySelectorAll(`${SELECTORS.liveAnchorContainer} a[href*="space.bilibili.com/"]`))
                .map((node) => extractUidFromHref(node.getAttribute('href'))));
            if (Number.isFinite(liveHrefUid)) {
                return liveHrefUid;
            }
        }

        if (trigger.closest(SELECTORS.spaceHeaderContainer)) {
            const pathMatchedUid = extractUidFromHref(location.href);
            if (Number.isFinite(pathMatchedUid)) {
                return pathMatchedUid;
            }

            const headerHrefUid = firstFiniteNumber(Array.from(document.querySelectorAll(`${SELECTORS.spaceHeaderContainer} a[href*="space.bilibili.com/"]`))
                .map((node) => extractUidFromHref(node.getAttribute('href'))));
            if (Number.isFinite(headerHrefUid)) {
                return headerHrefUid;
            }
        }

        const followCard = trigger.closest(SELECTORS.followCardContainer);
        if (followCard instanceof HTMLElement) {
            const cardUid = extractUidFromCard(followCard);
            if (Number.isFinite(cardUid)) {
                return cardUid;
            }
        }

        return NaN;
    }

    /**
     * 从按钮往上收集一小段上下文容器，方便在不同页面结构里寻找 UID。
     *
     * @param {HTMLElement} trigger
     * @returns {HTMLElement[]}
     */
    function getClosestActionContextCandidates(trigger) {
        const candidates = [];
        let current = trigger.parentElement;
        let depth = 0;
        while (current instanceof HTMLElement && depth < 5) {
            candidates.push(current);
            current = current.parentElement;
            depth += 1;
        }
        return candidates;
    }

    /**
     * 打开单用户“先选择分组再关注”的面板。
     *
     * @param {number} uid
     */
    async function openSingleUserFollowDialog(uid) {
        if (state.busy) {
            return;
        }

        try {
            setBusy(true);
            const groups = await loadGroupOptions();
            openSetGroupDialog(groups, [uid], {
                confirmSuccessMessage: '已完成关注并设置分组',
                reloadOnSubmit: false,
                emptyAction: 'unfollow',
                emptyButtonText: '取消关注',
                emptyButtonDanger: true,
                emptySuccessMessage: '当前尚未关注该 UP 主',
                reloadOnEmptySubmit: false,
                onSubmit: async (selectedUids, finalTagIds) => {
                    await followUser(selectedUids[0]);
                    await setUsersGroups(selectedUids, finalTagIds);
                    applyFollowSubmitResult(selectedUids);
                },
                onEmptySubmit: async () => {}
            });
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 打开关注分组面板失败`, error);
            showToast(getErrorMessage(error, '打开关注分组面板失败'));
        } finally {
            setBusy(false);
        }
    }

    /**
     * 打开单用户“设置分组”面板。
     * 这里会先读取该用户当前所在分组，并在弹窗里做预选，减少重复操作成本。
     *
     * @param {number} uid
     */
    async function openSingleUserSetGroupDialog(uid) {
        if (state.busy) {
            return;
        }

        try {
            setBusy(true);
            const [groups, currentTagIds] = await Promise.all([
                loadGroupOptions(),
                loadUserGroupTagIds(uid)
            ]);
            openSetGroupDialog(groups, [uid], {
                initialCheckedTagIds: currentTagIds,
                confirmSuccessMessage: '已提交分组设置',
                reloadOnSubmit: false
            });
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 打开设置分组面板失败`, error);
            showToast(getErrorMessage(error, '打开设置分组面板失败'));
        } finally {
            setBusy(false);
        }
    }

    /**
     * 在批量操作头部右侧插入“设置分组”按钮。
     * 只要检测到原生批量头部出现，就说明用户已经进入了批量操作模式。
     */
    function injectBatchButtons() {
        const batchModeButton = document.querySelector(SELECTORS.batchModeEnterButton);
        const headerRight = document.querySelector(SELECTORS.batchHeaderRight);
        if (!(headerRight instanceof HTMLElement)) {
            return;
        }

        const actionGroup = headerRight.querySelector(`.${CLASS_NAMES.actionGroup}`);
        const originalCopyButton = headerRight.querySelector(SELECTORS.originalCopyButton);

        /**
         * 只有标题区按钮切换成“返回”时，才认为当前真正进入了批量模式。
         * 这样可以避免“全部分组”默认状态下提前把自定义按钮显示出来。
         */
        if (!isBatchModeActive(batchModeButton)) {
            if (actionGroup instanceof HTMLElement) {
                actionGroup.remove();
            }
            if (originalCopyButton instanceof HTMLElement) {
                originalCopyButton.style.display = '';
            }
            return;
        }

        if (originalCopyButton instanceof HTMLElement) {
            originalCopyButton.style.display = 'none';
        }

        let ensuredActionGroup = actionGroup;
        if (!(ensuredActionGroup instanceof HTMLElement)) {
            ensuredActionGroup = document.createElement('div');
            ensuredActionGroup.className = CLASS_NAMES.actionGroup;
            headerRight.style.position = 'relative';

            const setGroupButton = createActionButton('设置分组', false, onSetGroupButtonClick);

            ensuredActionGroup.append(setGroupButton);
            headerRight.appendChild(ensuredActionGroup);
        }

        const selectedCount = getSelectedCount();
        ensuredActionGroup.querySelectorAll('button').forEach((button) => {
            button.disabled = selectedCount === 0 || state.busy;
            button.title = selectedCount === 0 ? '请先勾选要操作的 UP 主' : '';
        });
    }

    /**
     * 判断当前是否已进入原生批量操作模式。
     * 当前页面里，标题区按钮在进入批量模式后会从“批量操作”切换成“返回”。
     *
     * @param {Element | null} batchModeButton
     * @returns {boolean}
     */
    function isBatchModeActive(batchModeButton) {
        if (!(batchModeButton instanceof HTMLElement)) {
            return false;
        }
        return normalizeText(batchModeButton.textContent) === '返回';
    }

    /**
     * 创建批量操作按钮。
     *
     * @param {string} text
     * @param {boolean} danger
     * @param {(event: MouseEvent) => void} onClick
     * @returns {HTMLButtonElement}
     */
    function createActionButton(text, danger, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = [
            'vui_button',
            CLASS_NAMES.actionButton,
            danger ? CLASS_NAMES.actionButtonDanger : ''
        ].filter(Boolean).join(' ');
        button.textContent = text;
        button.addEventListener('click', onClick);
        return button;
    }

    /**
     * 处理“设置分组”按钮点击。
     * 这里会先读取分组列表，再弹出自定义对话框供你多选目标分组。
     */
    async function onSetGroupButtonClick() {
        const selectedUids = getSelectedUids();
        if (selectedUids.length === 0) {
            showToast('请先勾选要设置分组的 UP 主');
            return;
        }

        try {
            setBusy(true);
            if (selectedUids.length === 1) {
                const [groups, currentTagIds] = await Promise.all([
                    loadGroupOptions(),
                    loadUserGroupTagIds(selectedUids[0])
                ]);
                openSetGroupDialog(groups, selectedUids, {
                    initialCheckedTagIds: currentTagIds
                });
                return;
            }

            const groups = await loadGroupOptions();
            openSetGroupDialog(groups, selectedUids);
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 加载关注分组失败`, error);
            showToast(getErrorMessage(error, '加载关注分组失败'));
        } finally {
            setBusy(false);
        }
    }

    /**
     * 打开“设置分组”对话框。
     * 这里使用自定义弹层，而不是强行劫持原生“复制至”弹窗，避免和站内 Vue 状态互相干扰。
     * 交互语义与原生页面的差异点在于：
     * 1. 这里文案更明确，强调是“设置最终分组”
     * 2. 如果一个分组都不勾选，则执行取消关注
     * 3. 如果“默认分组”与其他分组同时勾选，会明确提示默认分组不会生效
     *
     * @param {Array<{tagid:number,name:string,count:number}>} groups
     * @param {number[]} selectedUids
     * @param {{
     *   title?: string,
     *   initialCheckedTagIds?: number[],
     *   confirmSuccessMessage?: string,
     *   reloadOnSubmit?: boolean,
     *   emptyAction?: 'unfollow' | 'close',
     *   emptyButtonText?: string,
     *   emptyButtonDanger?: boolean,
     *   emptySuccessMessage?: string,
     *   reloadOnEmptySubmit?: boolean,
     *   onSubmit?: (selectedUids:number[], finalTagIds:number[]) => Promise<void>,
     *   onEmptySubmit?: (selectedUids:number[]) => Promise<void>
     * }} options
     */
    function openSetGroupDialog(groups, selectedUids, options = {}) {
        closeAllOverlays();

        const overlay = document.createElement('div');
        overlay.className = CLASS_NAMES.overlay;

        const dialog = document.createElement('div');
        dialog.className = CLASS_NAMES.dialog;

        const title = document.createElement('div');
        title.className = CLASS_NAMES.dialogTitle;
        title.textContent = options.title || `设置 ${selectedUids.length} 个 UP 主的分组`;

        const list = document.createElement('div');
        list.className = CLASS_NAMES.dialogList;

        if (groups.length === 0) {
            const empty = document.createElement('div');
            empty.className = CLASS_NAMES.dialogEmpty;
            empty.textContent = '未读取到可用分组';
            list.appendChild(empty);
        } else {
            groups.forEach((group) => {
                const label = document.createElement('label');
                label.className = [
                    CLASS_NAMES.dialogItem,
                    group.tagid === DEFAULT_GROUP_TAG_ID ? CLASS_NAMES.dialogItemDefault : ''
                ].filter(Boolean).join(' ');
                label.dataset.tagId = String(group.tagid);

                const checkbox = document.createElement('input');
                checkbox.className = CLASS_NAMES.dialogItemCheckbox;
                checkbox.type = 'checkbox';
                checkbox.name = 'bfpo-target-group';
                checkbox.value = String(group.tagid);
                checkbox.checked = Array.isArray(options.initialCheckedTagIds)
                    && options.initialCheckedTagIds.includes(group.tagid);

                const content = document.createElement('div');
                content.className = CLASS_NAMES.dialogItemContent;

                const main = document.createElement('div');
                main.className = CLASS_NAMES.dialogItemMain;
                main.textContent = `${group.name} (${group.count ?? 0})`;

                content.appendChild(main);

                if (group.tagid === DEFAULT_GROUP_TAG_ID) {
                    const subnote = document.createElement('div');
                    subnote.className = CLASS_NAMES.dialogItemSubnote;
                    subnote.textContent = '未加入任何分组时加入';
                    content.appendChild(subnote);
                }

                const warning = document.createElement('div');
                warning.className = CLASS_NAMES.dialogItemWarning;
                warning.textContent = '默认分组不生效';

                label.append(checkbox, content, warning);
                list.appendChild(label);
            });
        }

        dialog.dataset.emptyAction = normalizeDialogEmptyAction(options.emptyAction);
        dialog.dataset.emptyButtonText = options.emptyButtonText || '';
        dialog.dataset.emptyButtonDanger = options.emptyButtonDanger === false ? 'false' : 'true';

        const footer = document.createElement('div');
        footer.className = CLASS_NAMES.dialogFooter;

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = CLASS_NAMES.dialogButton;
        cancelButton.textContent = '取消';
        cancelButton.addEventListener('click', closeActiveOverlay);

        const confirmButton = document.createElement('button');
        confirmButton.type = 'button';
        confirmButton.className = `${CLASS_NAMES.dialogButton} ${CLASS_NAMES.dialogButtonPrimary}`;
        confirmButton.textContent = '确认';
        confirmButton.disabled = groups.length === 0;
        confirmButton.addEventListener('click', async () => {
            const checkedTagIds = Array.from(dialog.querySelectorAll('input[name="bfpo-target-group"]:checked'))
                .map((input) => Number(input instanceof HTMLInputElement ? input.value : NaN))
                .filter((tagId) => Number.isFinite(tagId));

            try {
                setBusy(true);
                confirmButton.disabled = true;
                confirmButton.textContent = '确认中...';

                if (checkedTagIds.length === 0) {
                    const emptyAction = normalizeDialogEmptyAction(options.emptyAction);
                    if (emptyAction === 'close') {
                        if (typeof options.onEmptySubmit === 'function') {
                            await options.onEmptySubmit(selectedUids);
                        }
                        closeActiveOverlay();
                        return;
                    }

                    setBusy(false);
                    const confirmed = await openCustomConfirmDialog({
                        title: `取消关注 ${selectedUids.length} 个 UP 主`
                    });
                    if (!confirmed) {
                        confirmButton.disabled = false;
                        updateSetGroupDialogState(dialog, confirmButton);
                        return;
                    }

                    setBusy(true);
                    confirmButton.disabled = true;
                    confirmButton.textContent = '取消关注中...';
                    if (typeof options.onEmptySubmit === 'function') {
                        await options.onEmptySubmit(selectedUids);
                    } else {
                        await executeBatchUnfollow(selectedUids);
                    }
                    applyUnfollowSubmitResult(selectedUids);
                    closeActiveOverlay();
                    showToast(options.emptySuccessMessage || (selectedUids.length === 1 ? '操作已完成' : `已取消关注 ${selectedUids.length} 个 UP 主`));
                    if (options.reloadOnEmptySubmit === true) {
                        reloadLater();
                    }
                    return;
                }

                const hasDefaultGroup = checkedTagIds.includes(DEFAULT_GROUP_TAG_ID);
                const hasOtherGroups = checkedTagIds.some((tagId) => tagId !== DEFAULT_GROUP_TAG_ID);
                const finalTagIds = hasDefaultGroup && hasOtherGroups
                    ? checkedTagIds.filter((tagId) => tagId !== DEFAULT_GROUP_TAG_ID)
                    : checkedTagIds;

                if (hasDefaultGroup && hasOtherGroups) {
                    showToast('已同时勾选“默认分组”和其他分组，默认分组不会生效');
                }

                if (typeof options.onSubmit === 'function') {
                    await options.onSubmit(selectedUids, finalTagIds);
                } else {
                    await setUsersGroups(selectedUids, finalTagIds);
                }
                applyGroupSubmitResult(selectedUids, finalTagIds);
                closeActiveOverlay();
                showToast(options.confirmSuccessMessage || `已提交 ${selectedUids.length} 个 UP 主的分组设置`);
                if (options.reloadOnSubmit === true) {
                    reloadLater();
                }
            } catch (error) {
                console.error(`[${SCRIPT_NAME}] 批量设置分组失败`, error);
                showToast(getErrorMessage(error, '批量设置分组失败'));
                confirmButton.disabled = false;
                updateSetGroupDialogState(dialog, confirmButton);
            } finally {
                setBusy(false);
            }
        });

        footer.append(cancelButton, confirmButton);
        dialog.append(title, list, footer);
        overlay.appendChild(dialog);

        mountOverlay(overlay);
        bindSetGroupDialogState(dialog, confirmButton);
    }

    /**
     * 根据当前勾选情况，实时更新“默认分组”这一行的视觉状态。
     * 当它与其他分组同时勾选时，该行会高亮为警告态，并在右侧显示“默认分组不生效”。
     *
     * @param {HTMLElement} dialog
     * @param {HTMLButtonElement} confirmButton
     */
    function bindSetGroupDialogState(dialog, confirmButton) {
        const updateState = () => updateSetGroupDialogState(dialog, confirmButton);

        dialog.addEventListener('change', (event) => {
            const target = event.target;
            if (target instanceof HTMLInputElement && target.name === 'bfpo-target-group') {
                updateState();
            }
        });

        updateState();
    }

    /**
     * 统一更新“设置分组”弹窗里的状态反馈。
     * 这里同时处理两件事：
     * 1. 默认分组与其他分组冲突时，给默认分组行加红色警告态
     * 2. 当一个分组都没选时，把右下主按钮切成红色“取消关注”
     *
     * @param {HTMLElement} dialog
     * @param {HTMLButtonElement} confirmButton
     */
    function updateSetGroupDialogState(dialog, confirmButton) {
        const checkedTagIds = Array.from(dialog.querySelectorAll('input[name="bfpo-target-group"]:checked'))
            .map((input) => Number(input instanceof HTMLInputElement ? input.value : NaN))
            .filter((tagId) => Number.isFinite(tagId));

        const hasDefaultGroup = checkedTagIds.includes(DEFAULT_GROUP_TAG_ID);
        const hasOtherGroups = checkedTagIds.some((tagId) => tagId !== DEFAULT_GROUP_TAG_ID);
        const defaultRow = dialog.querySelector(`.${CLASS_NAMES.dialogItemDefault}`);

        if (defaultRow instanceof HTMLElement) {
            if (hasDefaultGroup && hasOtherGroups) {
                defaultRow.classList.add(CLASS_NAMES.dialogItemDefaultInactive);
            } else {
                defaultRow.classList.remove(CLASS_NAMES.dialogItemDefaultInactive);
            }
        }

        if (!(confirmButton instanceof HTMLButtonElement)) {
            return;
        }

        const emptyAction = normalizeDialogEmptyAction(dialog.dataset.emptyAction);
        const emptyButtonText = normalizeText(dialog.dataset.emptyButtonText) || (emptyAction === 'unfollow' ? '取消关注' : '取消');
        const emptyButtonDanger = dialog.dataset.emptyButtonDanger === 'true';

        confirmButton.classList.remove(CLASS_NAMES.dialogButtonPrimary, CLASS_NAMES.dialogButtonDanger);
        if (checkedTagIds.length === 0) {
            confirmButton.classList.add(emptyButtonDanger ? CLASS_NAMES.dialogButtonDanger : CLASS_NAMES.dialogButtonPrimary);
            confirmButton.textContent = emptyButtonText;
            return;
        }

        confirmButton.classList.add(CLASS_NAMES.dialogButtonPrimary);
        confirmButton.textContent = '确认';
    }

    /**
     * 打开自定义确认弹层，统一脚本内部的确认交互风格。
     * 这里不用浏览器原生 confirm，避免视觉风格和我们自己的面板割裂。
     *
     * @param {{title: string}} options
     * @returns {Promise<boolean>}
     */
    function openCustomConfirmDialog(options) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = CLASS_NAMES.overlay;
            overlay.style.zIndex = '2147483647';

            const dialog = document.createElement('div');
            dialog.className = CLASS_NAMES.dialog;

            const title = document.createElement('div');
            title.className = CLASS_NAMES.dialogTitle;
            title.textContent = options.title;

            const footer = document.createElement('div');
            footer.className = CLASS_NAMES.dialogFooter;

            const cancelButton = document.createElement('button');
            cancelButton.type = 'button';
            cancelButton.className = CLASS_NAMES.dialogButton;
            cancelButton.textContent = '取消';
            cancelButton.addEventListener('click', () => {
                removeOverlay(overlay);
                resolve(false);
            });

            const confirmButton = document.createElement('button');
            confirmButton.type = 'button';
            confirmButton.className = `${CLASS_NAMES.dialogButton} ${CLASS_NAMES.dialogButtonDanger}`;
            confirmButton.textContent = '取消关注';
            confirmButton.addEventListener('click', () => {
                removeOverlay(overlay);
                resolve(true);
            });

            footer.append(cancelButton, confirmButton);
            dialog.append(title, footer);
            overlay.appendChild(dialog);

            mountOverlay(overlay);
        });
    }

    /**
     * 加载关注分组列表。
     * 这里使用短时缓存，避免在同一轮操作里重复请求同一份分组数据。
     *
     * @returns {Promise<Array<{tagid:number,name:string,count:number}>>}
     */
    async function loadGroupOptions() {
        const now = Date.now();
        if (Array.isArray(state.groupOptionsCache) && now - state.groupOptionsCacheAt < 5000) {
            return state.groupOptionsCache;
        }

        const data = await requestJson(API.relationTags, {
            method: 'GET'
        });

        const groups = Array.isArray(data)
            ? data.map((item) => ({
                tagid: Number(item?.tagid),
                name: normalizeText(item?.name),
                count: Number(item?.count || 0)
            })).filter((item) => Number.isFinite(item.tagid) && item.name)
            : [];

        state.groupOptionsCache = groups;
        state.groupOptionsCacheAt = now;
        return groups;
    }

    /**
     * 获取某个已关注用户当前所在的分组。
     * 结果只用于预选弹窗状态，因此这里做一个轻量缓存即可。
     * 实测 `/x/relation/tag/user` 返回的是 `{ "<tagid>": "<tag_name>" }` 这种对象映射，
     * 而不是数组；如果返回空对象，则可以视为该用户当前只处于“默认分组”。
     *
     * @param {number} uid
     * @returns {Promise<number[]>}
     */
    async function loadUserGroupTagIds(uid) {
        const normalizedUid = Number(uid);
        if (!Number.isFinite(normalizedUid)) {
            return [];
        }

        if (state.singleUserGroupCache.has(normalizedUid)) {
            return state.singleUserGroupCache.get(normalizedUid) || [];
        }

        const data = await requestJson(API.relationTagUser, {
            method: 'GET',
            query: {
                fid: String(normalizedUid)
            }
        });

        const tagIds = Array.isArray(data)
            ? data.map((item) => Number(item?.tagid)).filter((tagId) => Number.isFinite(tagId))
            : Object.keys(data || {})
                .map((tagId) => Number(tagId))
                .filter((tagId) => Number.isFinite(tagId));

        const normalizedTagIds = tagIds.length > 0 ? tagIds : [DEFAULT_GROUP_TAG_ID];

        state.singleUserGroupCache.set(normalizedUid, normalizedTagIds);
        return normalizedTagIds;
    }

    /**
     * 执行单用户关注。
     *
     * @param {number} uid
     * @returns {Promise<void>}
     */
    async function followUser(uid) {
        const csrf = getCsrfToken();
        if (!csrf) {
            throw new Error('未读取到 bili_jct，无法提交关注请求');
        }

        await requestJson(API.modifyRelation, {
            method: 'POST',
            body: buildFormBody({
                fid: String(uid),
                act: '1',
                re_src: '11',
                csrf,
                csrf_token: csrf
            })
        });
    }

    /**
     * 调用 B 站“设置关注分组”接口。
     * 这里统一按“最终分组集合”来提交：
     * 1. 勾选了哪些分组，就把这些 tagid 一次性提交
     * 2. “默认分组”如果和其他分组同时出现，会在上层逻辑里被自动剔除
     *
     * @param {number[]} uids
     * @param {number[]} targetTagIds
     * @returns {Promise<void>}
     */
    async function setUsersGroups(uids, targetTagIds) {
        const csrf = getCsrfToken();
        if (!csrf) {
            throw new Error('未读取到 bili_jct，无法提交分组修改');
        }

        const normalizedTagIds = Array.from(new Set(
            targetTagIds
                .map((tagId) => Number(tagId))
                .filter((tagId) => Number.isFinite(tagId))
        ));

        if (normalizedTagIds.length === 0) {
            throw new Error('未提供有效分组，无法提交分组设置');
        }

        await requestJson(API.setUserSubscribeGroup, {
            method: 'POST',
            body: buildFormBody({
                fids: uids.join(','),
                tagids: normalizedTagIds.join(','),
                csrf,
                csrf_token: csrf
            })
        });
    }

    /**
     * 在“设置分组”成功后同步一份本地状态。
     * 这样即使不整页刷新，后续再次打开弹窗时也能直接看到最新预选结果，
     * 同时把分组列表缓存失效掉，避免分组计数长期停留在旧值。
     *
     * @param {number[]} uids
     * @param {number[]} finalTagIds
     */
    function applyGroupSubmitResult(uids, finalTagIds) {
        const normalizedTagIds = Array.from(new Set(
            finalTagIds
                .map((tagId) => Number(tagId))
                .filter((tagId) => Number.isFinite(tagId))
        ));

        const nextTagIds = normalizedTagIds.length > 0 ? normalizedTagIds : [DEFAULT_GROUP_TAG_ID];
        uids.forEach((uid) => {
            const normalizedUid = Number(uid);
            if (!Number.isFinite(normalizedUid)) {
                return;
            }
            state.singleUserGroupCache.set(normalizedUid, [...nextTagIds]);
        });

        state.groupOptionsCache = null;
        state.groupOptionsCacheAt = 0;
        injectBatchButtons();
    }

    /**
     * 在“先关注再分组”成功后，同步当前页面里的关注按钮状态。
     * 这里不依赖整页刷新，而是把同 UID 的按钮先切到“已关注”，
     * 再触发一次镜像按钮重建，让后续点击直接进入“设置分组”流程。
     *
     * @param {number[]} uids
     */
    function applyFollowSubmitResult(uids) {
        const uidSet = new Set(
            uids
                .map((uid) => Number(uid))
                .filter((uid) => Number.isFinite(uid))
        );
        if (uidSet.size === 0) {
            return;
        }

        const candidateButtons = new Set([
            ...state.managedFollowButtons.keys(),
            ...collectManagedFollowCandidates(),
            ...document.querySelectorAll(SELECTORS.nativeFollowButton)
        ]);

        candidateButtons.forEach((button) => {
            if (!(button instanceof HTMLElement)) {
                return;
            }

            const uid = extractUidFromActionTrigger(button);
            if (!uidSet.has(uid)) {
                return;
            }

            markFollowButtonAsFollowed(button);
        });

        syncManagedFollowButtons();
    }

    /**
     * 把单个关注按钮就地改成“已关注”状态。
     * 这里优先保留原有类名，只补最关键的语义类和文案，
     * 尽量减少对 B 站原按钮布局的干扰。
     *
     * @param {HTMLElement} button
     */
    function markFollowButtonAsFollowed(button) {
        button.classList.add('following');
        button.classList.remove('not-follow');
        button.dataset.curbuttonstrategy = '已关注';
        button.setAttribute('aria-label', '已关注');
        button.textContent = '已关注';
    }

    /**
     * 在“取消关注”成功后同步当前页面状态。
     * 这里会把同 UID 的按钮切回“关注”，并在关注页中移除对应卡片，
     * 从而避免必须靠整页刷新才能看到正确结果。
     *
     * @param {number[]} uids
     */
    function applyUnfollowSubmitResult(uids) {
        const uidSet = new Set(
            uids
                .map((uid) => Number(uid))
                .filter((uid) => Number.isFinite(uid))
        );
        if (uidSet.size === 0) {
            return;
        }

        uidSet.forEach((uid) => {
            state.singleUserGroupCache.delete(uid);
        });
        state.groupOptionsCache = null;
        state.groupOptionsCacheAt = 0;

        const candidateButtons = new Set([
            ...state.managedFollowButtons.keys(),
            ...collectManagedFollowCandidates(),
            ...document.querySelectorAll(SELECTORS.nativeFollowButton)
        ]);

        candidateButtons.forEach((button) => {
            if (!(button instanceof HTMLElement)) {
                return;
            }

            const uid = extractUidFromActionTrigger(button);
            if (!uidSet.has(uid)) {
                return;
            }

            markFollowButtonAsUnfollowed(button);
        });

        removeFollowCardsByUid(uidSet);
        syncManagedFollowButtons();
        injectBatchButtons();
    }

    /**
     * 把单个关注按钮就地改成“关注”状态。
     * 这里只补最核心的文案、类名和语义属性，
     * 让脚本随后重建出来的镜像按钮能稳定识别为未关注态。
     *
     * @param {HTMLElement} button
     */
    function markFollowButtonAsUnfollowed(button) {
        button.classList.add('not-follow');
        button.classList.remove('following');
        button.dataset.curbuttonstrategy = '关注';
        button.setAttribute('aria-label', '关注');
        button.textContent = '关注';
    }

    /**
     * 在关注页里移除刚刚取消关注的卡片，并尽量同步头部已选数量显示。
     * 这样批量取消后，列表会立刻收敛到最新状态，不会留下一批已经失效的卡片。
     *
     * @param {Set<number>} uidSet
     */
    function removeFollowCardsByUid(uidSet) {
        if (!(uidSet instanceof Set) || uidSet.size === 0) {
            return;
        }

        document.querySelectorAll(SELECTORS.relationCard).forEach((card) => {
            if (!(card instanceof HTMLElement)) {
                return;
            }

            const uid = extractUidFromCard(card);
            if (!uidSet.has(uid)) {
                return;
            }

            card.remove();
        });

        const selectedCountNode = document.querySelector(SELECTORS.selectedCount);
        if (selectedCountNode instanceof HTMLElement) {
            const nextSelectedCount = getSelectedUids().length;
            const currentText = normalizeText(selectedCountNode.textContent);
            if (/\d+/.test(currentText)) {
                selectedCountNode.textContent = currentText.replace(/\d+/, String(nextSelectedCount));
            }
        }
    }

    /**
     * 批量取消关注。
     * 为了降低风控与失败率，这里限制并发数，并在每轮之间增加一点轻微间隔。
     *
     * @param {number[]} uids
     * @returns {Promise<{success:number[],failed:Array<{uid:number,error:string}>}>}
     */
    async function batchUnfollow(uids) {
        const csrf = getCsrfToken();
        if (!csrf) {
            throw new Error('未读取到 bili_jct，无法提交取消关注请求');
        }

        const pendingQueue = [...uids];
        const success = [];
        const failed = [];

        const workers = Array.from({ length: Math.min(CONFIG.unfollowConcurrency, pendingQueue.length) }, async () => {
            while (pendingQueue.length > 0) {
                const uid = pendingQueue.shift();
                if (!Number.isFinite(uid)) {
                    continue;
                }

                try {
                    await requestJson(API.modifyRelation, {
                        method: 'POST',
                        body: buildFormBody({
                            fid: String(uid),
                            act: '2',
                            re_src: '11',
                            csrf,
                            csrf_token: csrf
                        })
                    });
                    success.push(uid);
                } catch (error) {
                    failed.push({
                        uid,
                        error: getErrorMessage(error, '请求失败')
                    });
                }

                if (pendingQueue.length > 0) {
                    await sleep(CONFIG.requestGap);
                }
            }
        });

        await Promise.all(workers);
        return { success, failed };
    }

    /**
     * 封装“带结果校验”的批量取消关注执行逻辑。
     * 这样“全不选 -> 取消关注”这条路径可以直接复用同一套错误处理。
     *
     * @param {number[]} selectedUids
     * @returns {Promise<void>}
     */
    async function executeBatchUnfollow(selectedUids) {
        showToast(`正在取消关注 ${selectedUids.length} 个 UP 主...`, 4000);
        const result = await batchUnfollow(selectedUids);

        if (result.failed.length > 0) {
            console.warn(`[${SCRIPT_NAME}] 部分取消关注失败`, result.failed);
            throw new Error(`已取消关注 ${result.success.length} 个，失败 ${result.failed.length} 个`);
        }
    }

    /**
     * 向 B 站接口发起请求并解析 JSON。
     * 统一在这里处理登录态、Referer、错误码和异常信息。
     *
     * @param {string} url
     * @param {{method:'GET'|'POST',body?:string,query?:Record<string,string>}} options
     * @returns {Promise<any>}
     */
    async function requestJson(url, options) {
        const requestUrl = buildRequestUrl(url, options.query);
        const response = await fetch(requestUrl, {
            method: options.method,
            body: options.body,
            credentials: 'include',
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();
        if (Number(result?.code) !== 0) {
            const message = normalizeText(result?.message || result?.msg) || `接口返回错误码 ${result?.code}`;
            throw new Error(message);
        }

        return result.data;
    }

    /**
     * 拼接带 query 的请求 URL。
     *
     * @param {string} url
     * @param {Record<string, string> | undefined} query
     * @returns {string}
     */
    function buildRequestUrl(url, query) {
        if (!query || Object.keys(query).length === 0) {
            return url;
        }

        const requestUrl = new URL(url);
        Object.entries(query).forEach(([key, value]) => {
            requestUrl.searchParams.set(key, value);
        });
        return requestUrl.toString();
    }

    /**
     * 获取当前已勾选的 UID 列表。
     * 这里优先从头像节点的 data-user-profile-id 提取，取不到时再回退到 href 正则。
     *
     * @returns {number[]}
     */
    function getSelectedUids() {
        const checkedBoxes = Array.from(document.querySelectorAll(SELECTORS.selectedCardCheckbox));
        const uidSet = new Set();

        checkedBoxes.forEach((checkboxLabel) => {
            const relationCard = checkboxLabel.closest(SELECTORS.relationCard);
            if (!(relationCard instanceof HTMLElement)) {
                return;
            }

            const uid = extractUidFromCard(relationCard);
            if (Number.isFinite(uid)) {
                uidSet.add(uid);
            }
        });

        return Array.from(uidSet);
    }

    /**
     * 获取当前批量模式下的已选数量。
     * 优先使用页面头部显示值；取不到时再退回到实际勾选数。
     *
     * @returns {number}
     */
    function getSelectedCount() {
        const countNode = document.querySelector(SELECTORS.selectedCount);
        const text = normalizeText(countNode?.textContent);
        const matched = text.match(/\d+/);
        if (matched) {
            return Number(matched[0]);
        }
        return getSelectedUids().length;
    }

    /**
     * 从单张关注卡片中提取目标 UID。
     *
     * @param {Element} relationCard
     * @returns {number}
     */
    function extractUidFromCard(relationCard) {
        const avatar = relationCard.querySelector(SELECTORS.relationCardAvatar);
        if (!(avatar instanceof HTMLElement)) {
            return NaN;
        }

        const datasetUid = Number(avatar.dataset.userProfileId);
        if (Number.isFinite(datasetUid)) {
            return datasetUid;
        }

        const href = avatar.getAttribute('href') || '';
        const matched = href.match(/space\.bilibili\.com\/(\d+)/);
        return matched ? Number(matched[1]) : NaN;
    }

    /**
     * 读取 `bili_jct`，这是大多数需要登录写操作的接口所必需的 CSRF Token。
     *
     * @returns {string}
     */
    function getCsrfToken() {
        const matched = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
        return matched ? decodeURIComponent(matched[1]) : '';
    }

    /**
     * 把对象序列化成 `application/x-www-form-urlencoded` 形式。
     *
     * @param {Record<string, string>} data
     * @returns {string}
     */
    function buildFormBody(data) {
        const form = new URLSearchParams();
        Object.entries(data).forEach(([key, value]) => {
            form.append(key, value);
        });
        return form.toString();
    }

    /**
     * 显示顶部提示。
     *
     * @param {string} message
     * @param {number} duration
     */
    function showToast(message, duration = CONFIG.toastDuration) {
        const text = normalizeText(message);
        if (!text) {
            return;
        }

        let root = state.toastRoot;
        if (!(root instanceof HTMLElement) || !root.isConnected) {
            root = document.createElement('div');
            root.className = CLASS_NAMES.toastRoot;
            document.body.appendChild(root);
            state.toastRoot = root;
        }

        root.textContent = '';
        const toast = document.createElement('div');
        toast.className = CLASS_NAMES.toast;
        toast.textContent = text;
        root.appendChild(toast);

        window.clearTimeout(state.toastTimer);
        state.toastTimer = window.setTimeout(() => {
            if (root.isConnected) {
                root.remove();
            }
            if (state.toastRoot === root) {
                state.toastRoot = null;
            }
        }, duration);
    }

    /**
     * 切换忙碌状态，并同步更新批量操作按钮可用性。
     *
     * @param {boolean} nextBusy
     */
    function setBusy(nextBusy) {
        state.busy = Boolean(nextBusy);
        injectBatchButtons();
    }

    /**
     * 关闭当前激活的弹层。
     */
    function closeActiveOverlay() {
        removeOverlay(state.activeOverlay);
    }

    /**
     * 关闭所有自定义弹层。
     * 这里主要用于页面路由切换、脚本销毁和重新打开主弹层时的一次性清场。
     */
    function closeAllOverlays() {
        while (state.overlayStack.length > 0) {
            const overlay = state.overlayStack[state.overlayStack.length - 1];
            removeOverlay(overlay);
        }
        unlockPageScroll(true);
    }

    /**
     * 挂载一个新的自定义弹层，并纳入统一的弹层栈管理。
     *
     * @param {HTMLElement} overlay
     */
    function mountOverlay(overlay) {
        document.body.appendChild(overlay);
        state.overlayStack.push(overlay);
        state.activeOverlay = overlay;
        lockPageScroll();
    }

    /**
     * 移除指定弹层，并同步更新弹层栈顶部引用。
     *
     * @param {HTMLElement | null} overlay
     */
    function removeOverlay(overlay) {
        if (!(overlay instanceof HTMLElement)) {
            return;
        }

        const overlayIndex = state.overlayStack.lastIndexOf(overlay);
        if (overlayIndex !== -1) {
            state.overlayStack.splice(overlayIndex, 1);
            unlockPageScroll();
        }

        if (overlay.isConnected) {
            overlay.remove();
        }

        state.activeOverlay = state.overlayStack[state.overlayStack.length - 1] || null;
    }

    /**
     * 在自定义弹层打开期间锁住整页滚动。
     * 这样滚轮即使落在弹窗的标题、页脚或遮罩层上，也不会把背后的页面带着一起滚。
     */
    function lockPageScroll() {
        if (state.scrollLockCount === 0) {
            state.previousBodyOverflow = document.body.style.overflow;
            state.previousHtmlOverflow = document.documentElement.style.overflow;
            document.body.style.overflow = 'hidden';
            document.documentElement.style.overflow = 'hidden';
        }

        state.scrollLockCount += 1;
    }

    /**
     * 释放整页滚动锁。
     * 这里用计数而不是布尔值，是为了兼容“设置分组弹窗上再叠一层确认弹窗”的场景。
     */
    function unlockPageScroll(force = false) {
        if (force) {
            state.scrollLockCount = 0;
        } else if (state.scrollLockCount > 0) {
            state.scrollLockCount -= 1;
        }

        if (state.scrollLockCount > 0) {
            return;
        }

        document.body.style.overflow = state.previousBodyOverflow;
        document.documentElement.style.overflow = state.previousHtmlOverflow;
        state.previousBodyOverflow = '';
        state.previousHtmlOverflow = '';
    }

    /**
     * 操作成功后延迟刷新。
     * 这样用户能先看到提示，再让页面回到 B 站自己的最新状态。
     */
    function reloadLater() {
        window.setTimeout(() => {
            location.reload();
        }, 900);
    }

    /**
     * 统一生成可读的错误信息。
     *
     * @param {unknown} error
     * @param {string} fallback
     * @returns {string}
     */
    function getErrorMessage(error, fallback) {
        if (error instanceof Error && normalizeText(error.message)) {
            return error.message;
        }
        return fallback;
    }

    /**
     * 标准化文本，方便做按钮文本判断与错误消息展示。
     *
     * @param {unknown} value
     * @returns {string}
     */
    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    /**
     * 标准化弹窗在“一个分组都不选”时的行为。
     *
     * @param {string | undefined} action
     * @returns {'unfollow' | 'close'}
     */
    function normalizeDialogEmptyAction(action) {
        return action === 'close' ? 'close' : 'unfollow';
    }

    /**
     * 从字符串数组里取第一个可转成有限数字的值。
     *
     * @param {Array<string | number | undefined>} values
     * @returns {number}
     */
    function firstFiniteNumber(values) {
        for (const value of values) {
            const normalized = Number(value);
            if (Number.isFinite(normalized)) {
                return normalized;
            }
        }
        return NaN;
    }

    /**
     * 从链接里解析 UID。
     *
     * @param {string | null} href
     * @returns {number}
     */
    function extractUidFromHref(href) {
        const normalizedHref = String(href || '');
        const spaceMatched = normalizedHref.match(/space\.bilibili\.com\/(\d+)/);
        if (spaceMatched) {
            return Number(spaceMatched[1]);
        }

        const whisperMatched = normalizedHref.match(/mid(\d+)/);
        return whisperMatched ? Number(whisperMatched[1]) : NaN;
    }

    /**
     * 简单的异步等待工具。
     *
     * @param {number} ms
     * @returns {Promise<void>}
     */
    function sleep(ms) {
        return new Promise((resolve) => {
            window.setTimeout(resolve, ms);
        });
    }

    /**
     * 注入脚本样式。
     * 样式尽量贴近 B 站当前浅色 UI，既不突兀，也能和原生按钮区分开。
     */
    function installStyle() {
        if (document.getElementById(CLASS_NAMES.style)) {
            return;
        }

        const style = document.createElement('style');
        style.id = CLASS_NAMES.style;
        style.textContent = `
            .${CLASS_NAMES.actionGroup} {
                position: absolute;
                right: 0;
                bottom: 0;
                display: flex;
                align-items: center;
            }
            .${CLASS_NAMES.actionButton} {
                height: 34px;
                min-width: 100px;
                padding: 0 12px;
                border-radius: 8px;
                border: 1px solid var(--v_line_regular, #E3E5E7);
                background: var(--v_bg1_float, #FFFFFF);
                color: var(--v_text1, #18191C);
                cursor: pointer;
                font-size: 14px;
                line-height: 1;
                white-space: nowrap;
                user-select: none;
                transition-property: color, background-color, border, transform;
                transition-duration: .2s;
            }
            .${CLASS_NAMES.actionButton}:hover:not(:disabled) {
                border-color: var(--v_brand_blue_active, #008AC5);
                color: var(--v_brand_blue_active, #008AC5);
            }
            .${CLASS_NAMES.actionButton}:disabled {
                opacity: 0.55;
                cursor: not-allowed;
            }
            .${CLASS_NAMES.actionButtonDanger} {
                border-color: #f2c1c0;
                color: #d14b49;
            }
            .${CLASS_NAMES.actionButtonDanger}:hover:not(:disabled) {
                border-color: #f85a54;
                color: #f85a54;
                background: #fff5f5;
            }
            .${CLASS_NAMES.toastRoot} {
                position: fixed;
                top: 76px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 2147483647;
                pointer-events: none;
            }
            .${CLASS_NAMES.toast} {
                max-width: min(72vw, 520px);
                padding: 10px 16px;
                border-radius: 10px;
                background: rgba(24, 25, 28, 0.92);
                color: #fff;
                font-size: 14px;
                line-height: 1.5;
                box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
                text-align: center;
            }
            .${CLASS_NAMES.overlay} {
                position: fixed;
                inset: 0;
                z-index: 2147483646;
                background: rgba(0, 0, 0, 0.42);
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 24px;
                box-sizing: border-box;
                overscroll-behavior: contain;
            }
            .${CLASS_NAMES.dialog} {
                width: min(520px, 100%);
                max-height: min(78vh, 700px);
                overflow: hidden;
                display: flex;
                flex-direction: column;
                background: #fff;
                border-radius: 14px;
                box-shadow: 0 18px 48px rgba(0, 0, 0, 0.18);
                overscroll-behavior: contain;
                box-sizing: border-box;
                font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
                font-size: 14px;
                line-height: 1.4;
                color: #18191c;
            }
            .${CLASS_NAMES.dialog},
            .${CLASS_NAMES.dialog} * {
                box-sizing: border-box;
            }
            .${CLASS_NAMES.dialogTitle} {
                padding: 20px 22px 16px;
                font-size: 20px;
                font-weight: 600;
                line-height: 1.3;
                color: #18191c;
            }
            .${CLASS_NAMES.dialogDesc} {
                padding: 0 22px 14px;
                font-size: 13px;
                line-height: 1.6;
                color: #61666d;
            }
            .${CLASS_NAMES.dialogList} {
                padding: 0 22px 12px;
                overflow: auto;
                overscroll-behavior: contain;
                scrollbar-gutter: stable;
            }
            .${CLASS_NAMES.dialogItem} {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 9px 12px;
                border-top: 1px solid #f1f2f3;
                font-size: 14px;
                line-height: 1.4;
                color: #18191c;
                cursor: pointer;
                border-radius: 10px;
                transition: background-color .2s ease, color .2s ease, border-color .2s ease;
            }
            .${CLASS_NAMES.dialogItem}:first-child {
                border-top: none;
            }
            .${CLASS_NAMES.dialogItemContent} {
                display: flex;
                align-items: baseline;
                gap: 8px;
                min-width: 0;
                flex: 1 1 auto;
                line-height: 1.4;
            }
            .${CLASS_NAMES.dialogItemMain} {
                min-width: 0;
                line-height: 1.4;
                color: inherit;
            }
            .${CLASS_NAMES.dialogItemSubnote} {
                flex: none;
                font-size: 12px;
                line-height: 1.4;
                color: #9499a0;
                white-space: nowrap;
            }
            .${CLASS_NAMES.dialogItemWarning} {
                flex: none;
                margin-left: auto;
                font-size: 12px;
                font-weight: 600;
                line-height: 1.4;
                color: #f85a54;
                white-space: nowrap;
                visibility: hidden;
            }
            .${CLASS_NAMES.dialogItemDefaultInactive} {
                color: #d1403e;
                background: #fff1f1;
                box-shadow: inset 0 0 0 1px rgba(209, 64, 62, 0.18);
            }
            .${CLASS_NAMES.dialogItemDefaultInactive} .${CLASS_NAMES.dialogItemSubnote} {
                color: #d1403e;
            }
            .${CLASS_NAMES.dialogItemDefaultInactive} .${CLASS_NAMES.dialogItemWarning} {
                visibility: visible;
            }
            .${CLASS_NAMES.dialogItemCheckbox} {
                margin: 0;
                accent-color: #00aeec;
            }
            .${CLASS_NAMES.dialogFooter} {
                display: flex;
                justify-content: flex-end;
                gap: 10px;
                padding: 14px 22px 22px;
                border-top: 1px solid #f1f2f3;
            }
            .${CLASS_NAMES.dialogButton} {
                width: 96px;
                min-width: 96px;
                height: 38px;
                padding: 0 12px;
                border-radius: 8px;
                border: 1px solid #d8dbe0;
                background: #fff;
                color: #18191c;
                cursor: pointer;
                box-sizing: border-box;
                line-height: 1;
                transition: all 0.2s ease;
            }
            .${CLASS_NAMES.dialogButton}:disabled {
                opacity: 0.55;
                cursor: not-allowed;
            }
            .${CLASS_NAMES.dialogButtonPrimary} {
                border-color: #00aeec;
                background: #00aeec;
                color: #fff;
            }
            .${CLASS_NAMES.dialogButtonDanger} {
                border-color: #f85a54;
                background: #f85a54;
                color: #fff;
            }
            .${CLASS_NAMES.managedFollowButton} {
                cursor: pointer;
            }
            .${CLASS_NAMES.dialogEmpty},
            .${CLASS_NAMES.dialogLoading} {
                padding: 18px 0 10px;
                font-size: 14px;
                color: #61666d;
                text-align: center;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * 脚本销毁逻辑。
     * 主要用于热更新和避免重复实例互相打架。
     */
    function destroy() {
        window.clearInterval(state.routeTimer);
        window.clearTimeout(state.mutationTimer);
        window.clearTimeout(state.toastTimer);
        document.removeEventListener('click', handleDocumentInteraction, true);
        document.removeEventListener('change', handleDocumentInteraction, true);
        closeAllOverlays();
        unlockPageScroll(true);
        Array.from(state.managedFollowButtons.keys()).forEach((originalButton) => {
            restoreManagedFollowButton(originalButton);
        });
        if (state.pageObserver) {
            state.pageObserver.disconnect();
            state.pageObserver = null;
        }
        if (state.toastRoot instanceof HTMLElement && state.toastRoot.isConnected) {
            state.toastRoot.remove();
        }
        state.toastRoot = null;
    }
})();
