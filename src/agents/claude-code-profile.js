/**
 * claude-code-profile.js
 *
 * Claude Code 专项稳定性 Profile
 *
 * 把所有"是否对 Claude Code 严苛对待"的开关集中到一个 profile，
 * anthropic.js 入口处只读 profile，不再硬编码。
 *
 * Core behavior:
 *   - strictToolUse: true            严格校验工具名，避免过程话术被当作最终回答
 *   - dropToolPreamble: true         解析到 tool_use 时丢弃 cleanedText（"我来读取..."）
 *   - requireStopReasonToolUse: true tool_use 出现时 stop_reason 必须是 'tool_use'
 *   - maxCorrectionRetry: 1          通用纠偏重试最多 1 次
 *   - supportsThinking: partial      思维块来自 phase=think，输出成 thinking content_block
 *   - supportsContextManagement: false  不支持 context_management / mcp_servers
 *
 * Heuristics used by anthropic.js to separate progress narration, final
 * reports, and empty replies:
 *   - toolIntentPatterns        进度废话模式（"我先看一下" / "let me check" 等）
 *   - finalReportPatterns       最终报告模式（"已完成" / "Done" 等）
 *   - emptyResponseSafeText     空回复时的安全兜底文本
 *   - diagnosticLogKeys         诊断日志字段白名单
 *   - looksLikeFinalReport()    判定函数
 *   - looksLikeProgressNarration()  判定函数（语义别名，等价于 looksLikeIntendsToCallTool）
 */

/**
 * 进度废话 / 工具意图模式
 *  - 在 hasTools=true 且任务未完成时，命中这些模式的输出不能被当成最终回答
 *  - 必须触发工具调用纠偏（让模型补 tool_call）
 */
const TOOL_INTENT_PATTERNS = [
  // 中文：我+来/先/去/马上/立即/接下来/现在/准备/将 + 动词
  /(让我|我来|我先|我去|马上|立即|接下来|然后|现在|准备|将|这就)[\s\S]{0,12}(查|看|做|改|跑|试|写|修|处理|调|读|打开|执行|运行|调用|搜索|检查|生成|创建|输出|保存|整理|收集|编写)/,
  // 中文：需要/得/要/必须/准备 + 动词
  /(需要|得|要|必须|准备)[\s\S]{0,12}(查|看|做|改|跑|试|写|修|处理|调|读|打开|执行|运行|调用|搜索|检查|生成|创建|输出|保存|整理|收集|编写)/,
  // 英文：I'll / I will / let me / going to / need to / about to / now I will + 动词 (包含写、改、生成等)
  /\b(I'?ll|I will|let me|going to|need to|about to|ready to|now I'?ll|now I will)\s+(use|check|read|look|open|run|call|invoke|search|examine|write|edit|create|generate|save|gather|collect|produce|modify|update)\b/i,
  // 通用：tool / function call 关键词
  /\b(tool|function)\s*(call|use|invoke|execut)/i,
];

/**
 * 最终报告模式
 *  - 命中这些模式的输出表示模型已经完成所有工作并给出了结论
 *  - 不应触发工具调用纠偏
 */
const FINAL_REPORT_PATTERNS = [
  // 中文：明显的"已完成/已修复/已解决"等完成态句式
  /(已(完成|修复|解决|部署|重构|成功|上线|提交|发布|应用|更新|变更|迁移|合并|回滚|清理|删除|添加|创建|导入|导出|生成|配置|构建|搞定))|(修(复|改|好)(完成|完毕))|(改|调|跑|测试)(通|好|过|完毕)|(部署|重构)(完成|成功)/,
  // 中文：总结/报告/结论句式 + 收尾词
  /(总结|结论|答案|报告|汇报)[：:]|(变更|修改|更新)\s*(如下|列表)|(任务|工单|全部)\s*(完成|通过|搞定)|(搞定|结束|完成|完毕|收工|大功告成|告一段落)/,
  // 英文：done/fixed/completed + summary/conclusion + I have X the Y
  /\b(done|fixed|resolved|completed?|finished|all done|successfully|success)\b|\b(task|bug|issue|problem)\s+(is\s+)?(done|fixed|resolved|completed)\b|\b(here'?s\s+the\s+(summary|result|final|answer|conclusion)|in\s+conclusion|final\s+(answer|report|result|summary|version|solution|conclusion))\b/i,
];

/**
 * 空回复 / 兜底时的安全提示文本
 *  - 当模型"啥也没说"或返回完全空内容时使用
 *  - 不会让 Claude Code 看到空白消息导致任务提前结束
 */
const EMPTY_RESPONSE_SAFE_TEXT = "模型没有返回有效工具调用或最终内容，本轮已安全结束。请重试或缩小任务范围。";

/**
 * 诊断日志字段白名单
 *  - 用于在 anthropic.js / 上游日志中按 key 记录关键决策上下文
 *  - 不在白名单中的字段不写入日志，避免敏感信息泄露
 */
const DIAGNOSTIC_LOG_KEYS = [
  'requestId',
  'profile',
  'hasTools',
  'rawTextPreview',
  'parsedToolCallsCount',
  'progressNarrationDetected',
  'correctionRetryUsed',
  'finalReportDetected',
  'stopReason',
  'emittedBlockTypes'
];

const profile = Object.freeze({
  name: 'claude-code',
  version: '1.0.0',
  // 协议路线
  protocol: 'anthropic',
  // 工具调用严格性
  strictToolUse: true,
  dropToolPreamble: true,
  requireStopReasonToolUse: true,
  // 纠偏重试上限
  maxCorrectionRetry: 1,
  // 能力开关
  supportsThinking: 'partial',
  supportsContextManagement: false,
  // 兼容性 notice 等级（默认 debug，避免刷屏）
  compatibilityWarningLevel: 'debug',
  // 流式事件顺序严格化
  // 必须 message_start → content_block_start → delta → stop → message_delta → message_stop
  enforceAnthropicEventOrder: true,
  // 兼容性 notice 限流：同一种 warning 5 分钟内只打印一次
  compatibilityNoticeThrottleMs: 5 * 60 * 1000,
  // 通用纠偏"打算调工具但没调"中文/英文特征——anecdotal patterns only
  // 中文部分不能用 \b：中文无 word boundary；用首尾非汉字宽松匹配
  toolIntentPatterns: TOOL_INTENT_PATTERNS,
  // 最终报告模式：命中时不触发工具调用纠偏
  finalReportPatterns: FINAL_REPORT_PATTERNS,
  // 空回复时的安全兜底文本
  emptyResponseSafeText: EMPTY_RESPONSE_SAFE_TEXT,
  // 诊断日志字段白名单
  diagnosticLogKeys: DIAGNOSTIC_LOG_KEYS,
  // 重试次数限制：用本地 key 跟踪每请求 retry 计数
  retryCounterKey: 'claude_code_retry_count'
});

/**
 * 检查 profile 某个开关
 * @param {string} key
 * @returns {boolean|number|string|Array|undefined}
 */
const getFlag = (key) => {
  if (!Object.prototype.hasOwnProperty.call(profile, key)) return undefined;
  return profile[key];
};

/**
 * 判断一段文本是否属于"模型打算调用工具但没调用"
 * 用 profile.toolIntentPatterns 中所有正则逐个匹配
 * @param {string} text
 * @returns {boolean}
 */
const looksLikeIntendsToCallTool = (text) => {
  if (!text || typeof text !== 'string') return false;
  const t = text.slice(0, 800);
  return profile.toolIntentPatterns.some(re => re.test(t));
};

/**
 * 语义别名：progress narration === intends to call tool
 * anthropic.js / 测试中两种命名都接受
 */
const looksLikeProgressNarration = looksLikeIntendsToCallTool;

/**
 * 判断一段文本是否属于"最终报告"
 * 命中 finalReportPatterns 任一条即视为最终报告
 * @param {string} text
 * @returns {boolean}
 */
const looksLikeFinalReport = (text) => {
  if (!text || typeof text !== 'string') return false;
  const t = text.slice(0, 800);
  return profile.finalReportPatterns.some(re => re.test(t));
};

/**
 * 判断 profile 是否允许通用纠偏重试
 *  - maxCorrectionRetry=0: 永不重试
 *  - maxCorrectionRetry=3: 每请求最多 3 次（用 ctx 计数，外部维护）
 *
 * @param {number} currentRetryCount - 当前已重试次数
 * @returns {boolean}
 */
const canCorrectionRetry = (currentRetryCount) => {
  const cap = Number(profile.maxCorrectionRetry) || 0;
  if (cap <= 0) return false;
  return currentRetryCount < cap;
};

module.exports = {
  profile,
  getFlag,
  looksLikeIntendsToCallTool,
  looksLikeProgressNarration,
  looksLikeFinalReport,
  canCorrectionRetry
};
