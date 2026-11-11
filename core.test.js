import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { makeWorkbench } from './core.js';

globalThis.crypto ??= webcrypto;
function setup(initialMode = 'review') {
    let disk = { entries: { '1': { uid: 1, comment: '王城', key: ['王城'], content: '位于北方', extra: { keep: true } } } };
    let data = { drafts: [], history: [] };
    let selected = '设定';
    let mode = initialMode;
    let failSave = false;
    const app = makeWorkbench({
        read: async () => structuredClone(disk),
        save: async (_name, book) => { if (failSave) throw new Error('模拟故障'); disk = structuredClone(book); },
        createEntry: (_name, book) => { const uid = Math.max(0, ...Object.values(book.entries).map(e => e.uid)) + 1; return book.entries[uid] = { uid, key: [], comment: '', content: '', disable: false }; },
        loadState: () => structuredClone(data), saveState: value => { data = structuredClone(value); },
        selectedBook: () => selected, mode: () => mode, changed: () => {},
    });
    return { app, disk: () => disk, state: () => data, edit: fn => fn(disk), fail: () => { failSave = true; }, select: name => { selected = name; }, setMode: value => { mode = value; } };
}

test('确认模式先保存提案，应用时只修改正文并可撤销', async () => {
    const s = setup();
    const { revision } = await s.app.get(1);
    const proposal = await s.app.propose({ uid: 1, base_revision: revision, content: '位于南方', reason: '修正方位' });
    assert.match(proposal.status, /等待/);
    assert.equal(s.disk().entries[1].content, '位于北方');
    await s.app.apply(proposal.id);
    assert.equal(s.disk().entries[1].content, '位于南方');
    assert.deepEqual(s.disk().entries[1].extra, { keep: true });
    assert.equal(s.state().drafts.length, 0);
    await s.app.undo(s.state().history[0].id);
    assert.equal(s.disk().entries[1].content, '位于北方');
});

test('外部修改后拒绝应用旧提案，避免覆盖', async () => {
    const s = setup();
    const { revision } = await s.app.get(1);
    const draft = await s.app.propose({ uid: 1, base_revision: revision, content: '南方', reason: '修正' });
    s.edit(book => { book.entries[1].content = '东方'; });
    await assert.rejects(s.app.apply(draft.id), /已发生变化/);
    assert.equal(s.disk().entries[1].content, '东方');
});

test('读取之后条目变化时，拒绝基于旧内容提交修改', async () => {
    const s = setup('direct');
    const { revision } = await s.app.get(1);
    s.edit(book => { book.entries[1].content = '东方'; });
    await assert.rejects(s.app.propose({ uid: 1, base_revision: revision, content: '南方', reason: '修正' }), /读取后已变化/);
    assert.equal(s.disk().entries[1].content, '东方');
});

test('直接模式可以创建条目并撤销，切换世界书时拒绝跨书撤销', async () => {
    const s = setup('direct');
    const result = await s.app.propose({ title: '城区', keys: ['城区'], content: '旧城区', reason: '新增' });
    assert.equal(s.disk().entries[result.uid].content, '旧城区');
    s.select('其他');
    await assert.rejects(s.app.undo(s.state().history[0].id), /所属/);
    s.select('设定');
    await s.app.undo(s.state().history[0].id);
    assert.equal(s.disk().entries[result.uid], undefined);
});

test('保存失败时保留修改前快照并标记结果待核实', async () => {
    const s = setup('direct');
    const { revision } = await s.app.get(1);
    s.fail();
    await assert.rejects(s.app.propose({ uid: 1, base_revision: revision, content: '南方', reason: '修正' }), /保存或复核失败/);
    assert.equal(s.state().history[0].before.content, '位于北方');
    assert.equal(s.state().history[0].status, '写入结果待核实');
});
