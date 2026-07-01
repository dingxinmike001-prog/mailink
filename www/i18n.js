window.i18n = window.i18n || {};

(function () {
    'use strict';

    let langData = null;
    let loadPromise = null;
    let initialized = false;
    let readyResolve = null;
    const readyPromise = new Promise(resolve => { readyResolve = resolve; });
    const registeredRoots = new Set();
    const STORAGE_KEY = 'mailink-lang';
    const DEFAULT_LANG = 'en';

    function getCurrentLang() {
        try {
            return localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG;
        } catch (e) {
            return DEFAULT_LANG;
        }
    }

    function setCurrentLang(lang) {
        try {
            localStorage.setItem(STORAGE_KEY, lang);
        } catch (e) {}
    }

    function getBasePath() {
        const currentPath = window.location.pathname;
        if (currentPath.includes('/www/')) {
            const afterWWW = currentPath.split('/www/')[1];
            const depth = afterWWW.split('/').length;
            return '../'.repeat(depth);
        }
        return '../';
    }

    function getLangPath() {
        const lang = getCurrentLang();
        return getBasePath() + 'resources/sys/lang/' + lang + '.json';
    }

    function getLangListPath() {
        return getBasePath() + 'resources/sys/lang.json';
    }

    async function loadLangData() {
        if (langData && initialized) return langData;
        if (loadPromise) return loadPromise;

        loadPromise = fetch(getLangPath())
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(data => {
                langData = data;
                return data;
            })
            .catch(err => {
                console.error('[i18n] load lang file failed:', err);
                langData = {};
                return {};
            });

        return loadPromise;
    }

    function t(key, params) {
        if (!langData) {
            return key;
        }
        const parts = key.split('.');
        let value = langData;
        for (const part of parts) {
            if (value && typeof value === 'object' && part in value) {
                value = value[part];
            } else {
                return key;
            }
        }
        if (typeof value !== 'string') return key;

        if (params && typeof params === 'object') {
            for (const [k, v] of Object.entries(params)) {
                value = value.replace(new RegExp('\\{' + k + '\\}', 'g'), v);
            }
        }
        return value;
    }

    function initElements(root) {
        if (!langData) return;
        root = root || document;
        root.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            if (key) {
                el.textContent = t(key);
            }
        });
        root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.dataset.i18nPlaceholder;
            if (key) {
                el.placeholder = t(key);
            }
        });
        root.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.dataset.i18nTitle;
            if (key) {
                el.title = t(key);
            }
        });
        root.querySelectorAll('[data-i18n-alt]').forEach(el => {
            const key = el.dataset.i18nAlt;
            if (key) {
                el.alt = t(key);
            }
        });
        root.querySelectorAll('[data-i18n-html]').forEach(el => {
            const key = el.dataset.i18nHtml;
            if (key) {
                el.innerHTML = t(key);
            }
        });
    }

    function registerRoot(root) {
        if (root) {
            registeredRoots.add(root);
        }
    }

    function unregisterRoot(root) {
        registeredRoots.delete(root);
    }

    function refreshAll() {
        initElements(document);
        registeredRoots.forEach(root => {
            try {
                initElements(root);
            } catch (e) {
                console.error('[i18n] refreshAll error for root:', e);
            }
        });
    }

    async function setLang(lang) {
        if (getCurrentLang() === lang && langData) return;

        setCurrentLang(lang);
        langData = null;
        loadPromise = null;
        initialized = false;

        await loadLangData();
        initialized = true;

        refreshAll();

        window.dispatchEvent(new CustomEvent('lang-changed', { detail: { lang } }));
    }

    function getLang() {
        return getCurrentLang();
    }

    function getLocale() {
        const lang = getCurrentLang();
        const localeMap = {
            'tc': 'zh-TW',
            'sc': 'zh-CN',
            'en': 'en-US',
            'es': 'es-ES',
            'de': 'de-DE',
            'ja': 'ja-JP',
            'fr': 'fr-FR',
            'pt': 'pt-PT',
            'ru': 'ru-RU',
            'it': 'it-IT',
            'nl': 'nl-NL',
            'pl': 'pl-PL',
            'tr': 'tr-TR',
            'vi': 'vi-VN',
            'id': 'id-ID',
            'cs': 'cs-CZ',
            'ko': 'ko-KR',
            'uk': 'uk-UA',
            'hu': 'hu-HU',
            'sv': 'sv-SE'
        };
        return localeMap[lang] || 'zh-CN';
    }

    async function init(root) {
        if (initialized) {
            initElements(root);
            return;
        }
        await loadLangData();
        initialized = true;
        if (readyResolve) {
            readyResolve(langData);
        }
        window.dispatchEvent(new CustomEvent('i18n-ready', { detail: { lang: getCurrentLang(), data: langData } }));
        document.documentElement.classList.remove('i18n-loading');
        document.documentElement.classList.add('i18n-ready');
        initElements(root);
    }

    async function loadLangList() {
        try {
            const response = await fetch(getLangListPath());
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (err) {
            console.error('[i18n] load lang list failed:', err);
            return [];
        }
    }

    async function renderLangSelect(selectElement) {
        if (!selectElement) return;
        const langList = await loadLangList();
        const currentLang = getCurrentLang();

        selectElement.innerHTML = '';
        langList.forEach(item => {
            const option = document.createElement('option');
            option.value = item.code;
            option.textContent = item.name;
            selectElement.appendChild(option);
        });

        selectElement.value = currentLang;
    }

    window.i18n = {
        load: loadLangData,
        t: t,
        init: init,
        initElements: initElements,
        getData: () => langData,
        isReady: () => !!langData,
        whenReady: () => readyPromise,
        setLang: setLang,
        getLang: getLang,
        getLocale: getLocale,
        refreshAll: refreshAll,
        registerRoot: registerRoot,
        unregisterRoot: unregisterRoot,
        loadLangList: loadLangList,
        renderLangSelect: renderLangSelect
    };

    function autoInit() {
        document.documentElement.classList.add('i18n-loading');
        if (!initialized) {
            window.i18n.init();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        autoInit();
    }
})();
