const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

// The host owns the worldbook format; keep all fields except the requested content.
export function makeWorkbench({ read, save, createEntry, loadState, saveState, selectedBook, mode, changed }) {
    let busy = false;
    const readSnapshots = new Map();
    const state = () => loadState();
    const persist = data => { saveState(data); changed(); };
    const bookName = () => {
        const name = selectedBook();
        if (!name) throw new Error('请先在扩展设置中选择世界书。');
        return name;
    };
    async function locked(fn) {
        if (busy) throw new Error('上一项操作尚未结束，请稍后重试。');
        busy = true;
        try { return await fn(); } finally { busy = false; }
    }
    async function getBook(name) {
        const book = await read(name);
        if (!book || !book.entries || typeof book.entries !== 'object') throw new Error('世界书读取失败。');
        return book;
    }
    function find(book, uid) {
        const entry = Object.values(book.entries).find(e => String(e.uid) === String(uid));
        if (!entry) throw new Error(`未找到条目 ${uid}。`);
        return entry;
    }
    async function list(query = '') {
        if (typeof query !== 'string' || query.length > 200) throw new Error('搜索词无效。');
        const book = await getBook(bookName());
        const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const matches = Object.values(book.entries).filter(e => {
            const text = [e.comment, ...(e.key || []), e.content].join(' ').toLocaleLowerCase();
            return terms.every(term => text.includes(term));
        });
        return { total: matches.length, entries: matches.slice(0, 30).map(e => ({ uid: e.uid, title: e.comment || '', keys: e.key || [], excerpt: String(e.content || '').slice(0, 180) })) };
    }
    async function get(uid) {
        const name = bookName();
        const entry = find(await getBook(name), uid);
        const revision = newId();
        readSnapshots.set(revision, { book: name, entry: clone(entry) });
        if (readSnapshots.size > 200) readSnapshots.delete(readSnapshots.keys().next().value);
        return { uid: entry.uid, title: entry.comment || '', keys: entry.key || [], content: entry.content || '', revision };
    }
    async function propose({ uid, title, content, keys, reason, base_revision }) {
        if (typeof content !== 'string' || !content.trim() || content.length > 100000) throw new Error('正文不能为空，且不能超过 100000 字符。');
        if (typeof reason !== 'string' || reason.length > 1000) throw new Error('请提供简短修改理由。');
        const name = bookName();
        return locked(async () => {
            const book = await getBook(name);
            const isNew = uid === null || uid === undefined;
            if (isNew && (typeof title !== 'string' || !title.trim() || title.length > 200)) throw new Error('新条目需要标题。');
            if (isNew && (!Array.isArray(keys) || !keys.length || keys.length > 20 || keys.some(k => typeof k !== 'string' || !k.trim() || k.length > 100))) throw new Error('新条目需要 1 至 20 个关键词。');
            const before = isNew ? null : clone(find(book, uid));
            const snapshot = readSnapshots.get(base_revision);
            if (!isNew && (!snapshot || snapshot.book !== name || !same(snapshot.entry, before))) throw new Error('条目未读取或读取后已变化，请重新读取再修改。');
            const proposal = { id: newId(), book: name, uid: isNew ? null : before.uid, title: isNew ? title.trim() : (before.comment || `条目 ${before.uid}`), keys: isNew ? keys.map(k => k.trim()) : [], content, reason, before, created: Date.now() };
            if (mode() === 'direct') return applyProposal(proposal);
            const data = state();
            data.drafts.unshift(proposal);
            persist(data);
            return { status: '等待用户确认，尚未写入世界书', title: proposal.title, id: proposal.id };
        });
    }
    async function applyProposal(proposal) {
        if (bookName() !== proposal.book) throw new Error('当前选择的世界书与提案不一致。');
        const book = await getBook(proposal.book);
        let entry;
        if (proposal.uid === null) {
            entry = createEntry(proposal.book, book);
            if (!entry) throw new Error('无法创建条目。');
            entry.comment = proposal.title;
            entry.key = proposal.keys;
        } else {
            entry = find(book, proposal.uid);
            if (!same(entry, proposal.before)) throw new Error('条目自提案生成后已发生变化，请重新生成，避免覆盖其他修改。');
        }
        entry.content = proposal.content;
        const after = clone(entry);
        const data = state();
        const record = { id: newId(), book: proposal.book, uid: entry.uid, title: proposal.title, before: proposal.before, after, reason: proposal.reason, created: Date.now(), status: '准备写入' };
        data.history.unshift(record);
        persist(data); // Backup must succeed before writing.
        try {
            await save(proposal.book, book);
            const verified = find(await getBook(proposal.book), entry.uid);
            if (!same(verified, after)) throw new Error('写入后复核不一致。');
            record.status = '已应用';
        } catch (error) {
            record.status = '写入结果待核实';
            persist(data);
            throw new Error(`保存或复核失败，请检查世界书和历史记录：${error.message}`);
        }
        data.drafts = data.drafts.filter(d => d.id !== proposal.id);
        persist(data);
        return { status: '已写入并复核', title: proposal.title, uid: entry.uid };
    }
    async function apply(id) {
        return locked(async () => {
            const proposal = state().drafts.find(d => d.id === id);
            if (!proposal) throw new Error('找不到待确认的修改。');
            return applyProposal(proposal);
        });
    }
    function discard(id) {
        const data = state();
        data.drafts = data.drafts.filter(d => d.id !== id);
        persist(data);
    }
    async function undo(id) {
        return locked(async () => {
            const data = state();
            const record = data.history.find(h => h.id === id);
            if (!record || record.status !== '已应用') throw new Error('该记录不能撤销。');
            if (bookName() !== record.book) throw new Error('请先选择该记录所属的世界书。');
            const book = await getBook(record.book);
            const current = find(book, record.uid);
            if (!same(current, record.after)) throw new Error('条目在此修改后又发生变化，已停止撤销。');
            if (record.before === null) delete book.entries[String(record.uid)];
            else book.entries[String(record.uid)] = clone(record.before);
            await save(record.book, book);
            const verified = await getBook(record.book);
            const restored = Object.values(verified.entries).find(e => String(e.uid) === String(record.uid));
            if (record.before === null ? restored !== undefined : !same(restored, record.before)) throw new Error('撤销后复核失败，请检查世界书。');
            record.status = '已撤销';
            persist(data);
            return '已撤销';
        });
    }
    return { list, get, propose, apply, discard, undo };
}
