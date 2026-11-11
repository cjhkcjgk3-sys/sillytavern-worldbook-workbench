import { createWorldInfoEntry } from '/scripts/world-info.js'; // SillyTavern 1.19.0 host API
import { makeWorkbench } from './core.js';

const ID = 'worldbook_workbench';
const STORAGE = 'worldbook_workbench_v1';
const TOOL_NAMES = ['worldbook_workbench_search', 'worldbook_workbench_read', 'worldbook_workbench_write'];
let root;
let app;
let active = false;
const ctx = () => SillyTavern.getContext();
const settings = () => {
    const all = ctx().extensionSettings;
    all[ID] ??= { enabled: false, book: '', mode: 'review' };
    return all[ID];
};
function loadState() {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return { drafts: [], history: [] };
    const data = JSON.parse(raw);
    if (!Array.isArray(data.drafts) || !Array.isArray(data.history)) throw new Error('本地记录格式无效，请先备份浏览器数据。');
    return data;
}
function saveState(data) { localStorage.setItem(STORAGE, JSON.stringify(data)); }
async function readBook(name) {
    const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name }), cache: 'no-store' });
    if (!response.ok) throw new Error(`读取世界书失败（${response.status}）。`);
    return await response.json();
}
async function saveBook(name, book) {
    // Host save updates its cache and emits WORLDINFO_UPDATED. The caller rereads from the server.
    await ctx().saveWorldInfo(name, book, true);
}
function notice(message, error = false) {
    if (root) root.querySelector('[data-status]').textContent = message;
    if (error) console.error('[世界书协作工作台]', message);
}
function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function button(label, action) {
    const node = el('button', label, 'menu_button');
    node.type = 'button';
    node.addEventListener('click', async () => {
        node.disabled = true;
        try { await action(); } catch (error) { notice(error.message, true); }
        finally { node.disabled = false; }
    });
    return node;
}
function renderRecords() {
    if (!root) return;
    const draftsNode = root.querySelector('[data-drafts]');
    const historyNode = root.querySelector('[data-history]');
    draftsNode.replaceChildren();
    historyNode.replaceChildren();
    let data;
    try { data = loadState(); } catch (e) { notice(e.message, true); return; }
    const book = settings().book;
    const drafts = data.drafts.filter(d => d.book === book);
    const history = data.history.filter(h => h.book === book);
    if (!drafts.length) draftsNode.append(el('small', '暂无待确认修改'));
    for (const draft of drafts) {
        const details = el('details', undefined, 'wbw-record');
        details.append(el('summary', `${draft.uid === null ? '新建' : '修改'}：${draft.title}`));
        details.append(el('p', `理由：${draft.reason || '未提供'}`));
        if (draft.before) {
            details.append(el('strong', '修改前'));
            details.append(el('pre', draft.before.content || '', 'wbw-content'));
        } else details.append(el('p', `关键词：${draft.keys.join('、')}`));
        details.append(el('strong', '修改后'));
        details.append(el('pre', draft.content, 'wbw-content'));
        details.append(button('确认并应用', async () => { const result = await app.apply(draft.id); notice(`${result.status}：${result.title}`); }));
        details.append(button('丢弃', () => { app.discard(draft.id); notice('已丢弃待确认修改。'); }));
        draftsNode.append(details);
    }
    if (!history.length) historyNode.append(el('small', '暂无修改记录'));
    for (const item of history.slice(0, 30)) {
        const details = el('details', undefined, 'wbw-record');
        details.append(el('summary', `${item.title} · ${item.status} · ${new Date(item.created).toLocaleString()}`));
        details.append(el('p', `理由：${item.reason || '未提供'}`));
        details.append(el('strong', '修改前'));
        details.append(el('pre', item.before?.content ?? '（新建条目）', 'wbw-content'));
        details.append(el('strong', '修改后'));
        details.append(el('pre', item.after.content || '', 'wbw-content'));
        if (item.status === '已应用') details.append(button('撤销这次修改', async () => { await app.undo(item.id); notice('已撤销。'); }));
        historyNode.append(details);
    }
}
function populateBooks() {
    const select = root.querySelector('[data-book]');
    select.replaceChildren(new Option('请选择世界书', ''));
    const names = ctx().getWorldInfoNames();
    for (const name of names) select.add(new Option(name, name));
    if (settings().book && !names.includes(settings().book)) select.add(new Option(`${settings().book}（未找到）`, settings().book));
    select.value = settings().book || '';
}
function mount() {
    if (!active || root) return;
    const container = document.querySelector('#extensions_settings2');
    if (!container) { console.error('[世界书协作工作台] 找不到扩展设置区域'); return; }
    root = document.createElement('div');
    root.id = 'worldbook-workbench';
    root.className = 'inline-drawer';
    root.innerHTML = `<div class="inline-drawer-toggle inline-drawer-header"><b>世界书协作工作台</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content">
        <label class="checkbox_label"><input data-enabled type="checkbox">启用聊天工具</label>
        <label>操作的世界书<select data-book class="text_pole"></select></label>
        <label>修改方式<select data-mode class="text_pole"><option value="review">先确认，再应用</option><option value="direct">模型直接修改</option></select></label>
        <small>在聊天中请模型搜索、修改或新建条目。需要启用酒馆的工具调用，且模型接口支持工具调用。世界书自动注入仍由酒馆的世界书绑定和触发规则控制。</small>
        <div data-status class="wbw-status" role="status"></div>
        <details open><summary>待确认修改</summary><div data-drafts></div></details>
        <details><summary>修改记录与撤销</summary><small>记录存于当前浏览器；清理浏览器数据会删除记录。</small><div data-history></div></details>
      </div>`;
    container.append(root);
    const s = settings();
    root.querySelector('[data-enabled]').checked = !!s.enabled;
    root.querySelector('[data-mode]').value = s.mode;
    populateBooks();
    root.querySelector('[data-enabled]').addEventListener('change', e => { s.enabled = e.target.checked; ctx().saveSettingsDebounced(); });
    root.querySelector('[data-book]').addEventListener('change', e => { s.book = e.target.value; ctx().saveSettingsDebounced(); renderRecords(); });
    root.querySelector('[data-book]').addEventListener('focus', populateBooks);
    root.querySelector('[data-mode]').addEventListener('change', e => { s.mode = e.target.value; ctx().saveSettingsDebounced(); });
    renderRecords();
}
function registerTools() {
    const c = ctx();
    const shouldRegister = () => active && !!settings().enabled && !!settings().book;
    const tools = [
        { name: TOOL_NAMES[0], displayName: '搜索世界书', description: '搜索用户指定的一本世界书。返回条目编号、标题、关键词和摘要；空查询列出前 30 条。修改前先搜索并读取。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索词；多个词以空格分开' } }, required: ['query'] }, action: ({ query }) => app.list(query) },
        { name: TOOL_NAMES[1], displayName: '读取世界书条目', description: '读取搜索结果中某个条目的完整正文。修改前必须读取。', parameters: { type: 'object', properties: { uid: { type: 'integer', description: '条目编号' } }, required: ['uid'] }, action: ({ uid }) => app.get(uid) },
        { name: TOOL_NAMES[2], displayName: '提交世界书修改', description: '用户要求修改或新建世界书内容时调用。修改前必须读取已有条目，并原样传入读取结果中的 revision 作为 base_revision。正文必须是完整替换后的正文。省略 uid 表示新建，此时必须提供 title 和 keys。是否立即写入由用户的插件设置决定。未经用户要求，不要主动修改。', parameters: { type: 'object', properties: { uid: { type: 'integer', description: '已有条目编号；新建时省略' }, base_revision: { type: 'string', description: '读取已有条目时返回的 revision，新建时省略' }, title: { type: 'string', description: '新建条目标题' }, keys: { type: 'array', items: { type: 'string' }, description: '新建条目的触发关键词' }, content: { type: 'string', description: '完整的新正文' }, reason: { type: 'string', description: '修改理由' } }, required: ['content', 'reason'] }, action: args => app.propose(args) },
    ];
    for (const tool of tools) c.registerFunctionTool({ ...tool, shouldRegister });
}
export function activate() {
    if (active) return;
    const c = ctx();
    const required = ['registerFunctionTool', 'unregisterFunctionTool', 'getWorldInfoNames', 'saveWorldInfo', 'getRequestHeaders'];
    const missing = required.filter(name => typeof c[name] !== 'function');
    if (missing.length) { console.error(`[世界书协作工作台] 宿主缺少能力：${missing.join(', ')}`); return; }
    active = true;
    app = makeWorkbench({ read: readBook, save: saveBook, createEntry: createWorldInfoEntry, loadState, saveState, selectedBook: () => settings().book, mode: () => settings().mode, changed: renderRecords });
    registerTools();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
}
export function disable() {
    active = false;
    document.removeEventListener('DOMContentLoaded', mount);
    for (const name of TOOL_NAMES) ctx().unregisterFunctionTool(name);
    root?.remove();
    root = null;
}
