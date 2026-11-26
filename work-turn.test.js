import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorkTurn } from './work-turn.js';

const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });

test('模型在私有请求历史中按顺序收到工具结果', async () => {
    const invoked = [];
    const replies = [
        { content: null, tool_calls: [call('a', 'search'), call('b', 'read')] },
        { content: null, tool_calls: [call('c', 'write')] },
        { content: '已应用' },
    ];
    let requests = 0;
    const final = await runWorkTurn({
        instruction: '修改测试条目', maxToolRounds: 2, signal: new AbortController().signal,
        request: async (messages) => {
            const toolMessages = messages.filter(message => message.role === 'tool');
            assert.equal(toolMessages.length, [0, 2, 3][requests]);
            if (toolMessages.length) assert.equal(toolMessages.at(-1).content, invoked.at(-1));
            return replies[requests++];
        },
        invoke: async name => {
            invoked.push(name);
            return name;
        },
    });
    assert.equal(final, '已应用');
    assert.deepEqual(invoked, ['search', 'read', 'write']);
    assert.equal(requests, 3);
});

test('轮次上限会阻止继续执行工具', async () => {
    let requests = 0;
    let invoked = 0;
    await assert.rejects(runWorkTurn({
        instruction: '测试', maxToolRounds: 1, signal: new AbortController().signal,
        request: async () => ({ tool_calls: [call(String(++requests), 'write')] }),
        invoke: async () => { invoked++; return 'done'; },
    }), /轮数上限/);
    assert.equal(requests, 2);
    assert.equal(invoked, 1);
});

test('接口重复返回同一个调用编号时不会再次执行', async () => {
    let invoked = 0;
    await assert.rejects(runWorkTurn({
        instruction: '测试', maxToolRounds: 3, signal: new AbortController().signal,
        request: async () => ({ tool_calls: [call('a', 'write')] }),
        invoke: async () => { invoked++; return 'done'; },
    }), /重复的工具调用编号/);
    assert.equal(invoked, 1);
});

test('停止后，迟到的模型回复无法触发写入', async () => {
    const controller = new AbortController();
    let invoked = false;
    await assert.rejects(runWorkTurn({
        instruction: '测试', maxToolRounds: 3, signal: controller.signal,
        request: async () => {
            controller.abort();
            return { tool_calls: [call('a', 'write')] };
        },
        invoke: async () => { invoked = true; },
    }), { name: 'AbortError' });
    assert.equal(invoked, false);
});

test('首轮请求包含已选条目的正文和版本，用户只需描述改法', async () => {
    const entry = { uid: 0, title: '重名条目', content: '100', revision: 'fixture-revision' };
    const result = await runWorkTurn({
        instruction: '精炼一下这条。', entry, maxToolRounds: 2, signal: new AbortController().signal,
        request: async messages => {
            assert.equal(messages.filter(message => message.role === 'user').length, 1);
            assert.ok(messages[1].content.includes(JSON.stringify(entry)));
            assert.ok(messages[1].content.endsWith('精炼一下这条。'));
            return { content: '示例回复' };
        },
        invoke: async () => { throw new Error('不应执行工具'); },
    });
    assert.equal(result, '示例回复');
});
