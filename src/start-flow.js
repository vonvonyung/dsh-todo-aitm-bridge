// Phase 2: create the idea (if needed), show the resolved start configuration,
// and start work ONLY after an explicit confirmation of `true`.
// Cancel or a throwing confirm callback never reaches startWork().

import { BridgeError, clampText, mapTaskToIdea, sourceRefForTask } from './contract.js';

const inFlight = new Map();

export function formatPreview(preview) {
  const t = preview.target || {};
  const lines = [
    '将在 AI 任务台开始工作，使用以下现有配置：',
    `项目：${t.project ?? '(未知)'}`,
    `引擎：${t.engine ?? '(未知)'}`,
    `模型：${t.model ?? '(未知)'}`,
    '',
    `指令：${preview.instruction}`,
  ];
  if (Array.isArray(preview.sideEffects) && preview.sideEffects.length) {
    lines.push('', '副作用：', ...preview.sideEffects.map((s) => `- ${s}`));
  }
  return lines.join('\n');
}

/**
 * @returns {Promise<{state: 'busy'|'failed'|'partial'|'cancelled'|'started',
 *   stage?: string, ideaId?: string, created?: boolean, taskId?: string|null, error?: string}>}
 */
export function startWorkFlow({ client, task, confirm }) {
  let sourceRef;
  try {
    sourceRef = sourceRefForTask(task);
  } catch (err) {
    return Promise.resolve({ state: 'failed', stage: 'validate', error: err.message });
  }
  const key = `${sourceRef.plugin}:${sourceRef.taskId}`;
  if (inFlight.has(key)) return Promise.resolve({ state: 'busy' });
  const p = run(client, task, sourceRef, confirm).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function run(client, task, sourceRef, confirm) {
  let idea;
  try {
    idea = await client.createIdea(mapTaskToIdea(task));
  } catch (err) {
    return { state: 'failed', stage: 'create', error: messageOf(err) };
  }
  const base = { ideaId: idea.ideaId, created: idea.created };

  let preview;
  try {
    preview = await client.previewStart(idea.ideaId);
  } catch (err) {
    return { ...base, state: 'partial', stage: 'preview', error: messageOf(err) };
  }

  let approved = false;
  try {
    approved = (await confirm(preview)) === true;
  } catch {
    approved = false;
  }
  if (!approved) return { ...base, state: 'cancelled' };

  try {
    const r = await client.startWork(idea.ideaId, {
      sourceRef,
      confirmedPreviewDigest: preview.digest,
    });
    if (!r.started) {
      return { ...base, state: 'partial', stage: 'start', error: 'AI 任务台未确认启动' };
    }
    return { ...base, state: 'started', taskId: r.taskId };
  } catch (err) {
    return { ...base, state: 'partial', stage: 'start', error: messageOf(err) };
  }
}

function messageOf(err) {
  return err instanceof BridgeError ? err.message : '未知错误';
}

/** User-facing toast text for a flow result (kept under the todo toast limit). */
export function toastFor(result) {
  switch (result.state) {
    case 'started':
      return clampText('已在 AI 任务台开始工作，原待办保持不变');
    case 'cancelled':
      return clampText(result.created ? '已取消启动；想法已创建，未开始工作' : '已取消，未开始工作');
    case 'busy':
      return clampText('该待办正在处理中，请稍候');
    case 'partial': {
      const where = { preview: '无法获取启动配置', start: '启动工作失败' }[result.stage] ?? '后续步骤失败';
      return clampText(`想法已创建，但${where}：${result.error ?? ''}。可稍后重试`);
    }
    default:
      return clampText(`无法在 AI 任务台创建想法：${result.error ?? ''}`);
  }
}
