/**
 * @fileoverview JSDoc type definitions for Copilot Cost Analyzer.
 * These types describe the data structures from debug logs and our computed metrics.
 */

// ---------------------------------------------------------------------------
// Raw debug log types (from main.jsonl)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RawLlmRequestAttrs
 * @property {string} model
 * @property {number} inputTokens
 * @property {number} [cachedTokens] - may be absent in older sessions
 * @property {number} outputTokens
 * @property {number} [copilotUsageNanoAiu] - AIC in nano-units
 * @property {string} [debugName]
 * @property {string} [responseId]
 * @property {number} [maxTokens]
 * @property {string} [systemPromptFile]
 * @property {string} [toolsFile]
 * @property {number} [ttft] - time to first token (ms)
 */

/**
 * @typedef {Object} RawLlmRequest
 * @property {'llm_request'} type
 * @property {'ok'|'error'} status
 * @property {RawLlmRequestAttrs} attrs
 * @property {string} [ts] - ISO timestamp string
 */

/**
 * @typedef {Object} RawToolCallAttrs
 * @property {string} [args] - JSON string of arguments
 * @property {string} [result] - tool result (may be truncated at 5011 chars)
 * @property {string} [argsPreview] - short preview
 */

/**
 * @typedef {Object} RawToolCall
 * @property {'tool_call'} type
 * @property {string} name
 * @property {'ok'|'error'} status
 * @property {RawToolCallAttrs} attrs
 * @property {string} [ts]
 */

/**
 * @typedef {Object} RawUserMessage
 * @property {'user_message'} type
 * @property {Object} attrs
 * @property {string} attrs.content
 * @property {string} [ts]
 */

/**
 * @typedef {Object} RawTurnStart
 * @property {'turn_start'} type
 * @property {Object} attrs
 * @property {string} [ts]
 */

/**
 * @typedef {RawLlmRequest|RawToolCall|RawUserMessage|RawTurnStart} DebugLogEvent
 */

// ---------------------------------------------------------------------------
// Parsed / computed types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} LlmCall
 * @property {string} sessionId
 * @property {number} turnNumber
 * @property {number} callNumber - 1-based index within the session
 * @property {string} model
 * @property {number} inputTokens
 * @property {number|null} cachedTokens
 * @property {number} outputTokens
 * @property {number} cost - computed cost in USD
 * @property {number|null} aic - AI credits (nano-units)
 * @property {number|null} timestamp - Unix seconds
 * @property {string} [debugName]
 * @property {string} [status] - 'ok' | 'error'
 * @property {string|null} [spanId] - OpenTelemetry span ID
 * @property {number|null} [ttft] - time to first token (ms)
 * @property {number} [deltaInput] - inputTokens change from previous call
 * @property {number|null} [deltaCached] - cachedTokens change from previous call
 * @property {string|null} [parentSpanId] - OpenTelemetry parent span ID
 * @property {string|null} [systemPromptFile] - e.g. 'system_prompt_0.json'
 * @property {string|null} [toolsFile] - e.g. 'tools_0.json'
 * @property {string|null} [requestOptions] - JSON string of request options (model, reasoning.effort, etc.)
 * @property {string|null} [cacheBreakType] - 'compaction'|'model_switch'|'subagent_boundary'|'system_prompt_change'|'tools_changed'|'options_changed'|'retry'|'provider_eviction'
 * @property {number|null} [timeSincePrev] - seconds since previous LLM call (only set for cache breaks)
 */

/**
 * @typedef {Object} ToolCall
 * @property {string} sessionId
 * @property {number} turnNumber
 * @property {string} toolName
 * @property {string} [argsPreview]
 * @property {number} resultSize
 * @property {'ok'|'error'} status
 * @property {number|null} linkedLlmCallId
 * @property {number|null} timestamp
 * @property {number|null} [dur] - total request duration (ms)
 * @property {string|null} [parentSpanId] - parent OpenTelemetry span ID (links tool to LLM call)
 * @property {string|null} compressionMethod - 'outputDeltas' | 'compressOutput'
 */

/**
 * @typedef {Object} ModelSwitch
 * @property {string} sessionId
 * @property {string} fromModel
 * @property {string} toModel
 * @property {number} atCallNumber
 * @property {number|null} cacheBefore
 * @property {number|null} cacheAfter
 * @property {number} inputDelta
 * @property {number|null} timestamp
 */

/**
 * @typedef {Object} SessionSummary
 * @property {string} sessionId
 * @property {string} workspaceHash
 * @property {string|null} workspacePath
 * @property {string|null} title
 * @property {number|null} startTime
 * @property {number|null} endTime
 * @property {string[]} modelsUsed
 * @property {number} totalLlmCalls
 * @property {number} totalInputTokens
 * @property {number} totalOutputTokens
 * @property {number|null} totalCachedTokens
 * @property {number} totalCost
 * @property {number|null} totalAic
 * @property {'full'|'limited'} dataQuality
 * @property {boolean} hasModelSwitch
 * @property {boolean} hasSubagent
 * @property {string} sourcePath
 */

// ---------------------------------------------------------------------------
// Pricing types (from models.json)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TokenPrices
 * @property {number} input_price - price per 1M tokens (attocents * 10000)
 * @property {number} cache_price - price per 1M cached tokens
 * @property {number} output_price - price per 1M output tokens
 * @property {number} context_max - max context window
 * @property {number} output_max - max output tokens
 * @property {number} vision_input_price
 * @property {number} vision_output_price
 */

/**
 * @typedef {Object} ModelPricing
 * @property {string} id - model identifier (e.g. 'gpt-5.3-codex')
 * @property {string} display_name
 * @property {'chat'|'vision'} model_type
 * @property {Object} billing
 * @property {Object} billing.token_prices
 * @property {TokenPrices} billing.token_prices.default
 */

/**
 * @typedef {Object} ParsedPricing
 * @property {string} modelId
 * @property {string} displayName
 * @property {number} inputPrice - dollars per 1M tokens
 * @property {number} cachePrice - dollars per 1M tokens
 * @property {number} outputPrice - dollars per 1M tokens
 * @property {number} contextMax
 */

// ---------------------------------------------------------------------------
// New DB table types (v0.5.88+)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ModelCatalogEntry
 * @property {string} model_id - Primary key; model identifier (e.g. 'gpt-5.3-codex')
 * @property {string|null} display_name
 * @property {string|null} vendor - 'Anthropic' | 'OpenAI' | 'Google' | etc.
 * @property {string|null} family - Model family grouping
 * @property {string|null} category - 'powerful' | 'versatile' | etc.
 * @property {string|null} price_category - 'high' | 'medium' | 'low'
 * @property {number} is_preview - 0 or 1
 * @property {number} supports_vision - 0 or 1
 * @property {number} supports_tool_calls - 0 or 1
 * @property {number} supports_thinking - 0 or 1
 * @property {number|null} max_context_tokens
 * @property {number|null} max_output_tokens
 * @property {number|null} input_price_per_mtok
 * @property {number|null} output_price_per_mtok
 * @property {number|null} cache_price_per_mtok
 * @property {string|null} capabilities_json - Full capabilities object as JSON string
 * @property {number} updated_at - Unix timestamp
 */

/**
 * @typedef {Object} AgentResponse
 * @property {number} response_id - Autoincrement PK
 * @property {string} session_id
 * @property {number} turn_number
 * @property {string|null} response_text - Agent's response text
 * @property {string|null} reasoning_text - Agent's reasoning/thinking text
 * @property {number|null} timestamp - Unix seconds
 * @property {string|null} span_id - OpenTelemetry span ID
 * @property {string|null} parent_span_id
 */

/**
 * @typedef {Object} DiscoveryEvent
 * @property {number} event_id - Autoincrement PK
 * @property {string} session_id
 * @property {string} event_type - 'Agent Discovery' | 'Instructions Discovery' | 'Skill Discovery' | etc.
 * @property {string|null} event_name - Name of the discovered item
 * @property {string|null} details - Additional details (e.g. file path, URL)
 * @property {number|null} timestamp - Unix seconds
 */

/**
 * @typedef {Object} TranscriptEvent
 * @property {number} transcript_id - Autoincrement PK
 * @property {string} session_id
 * @property {string} event_type - 'session.start' | 'assistant.message' | 'tool.execution_start' | etc.
 * @property {string|null} event_data - Full event JSON string
 * @property {string|null} event_uuid - Unique event ID from transcript
 * @property {string|null} parent_uuid - Parent event UUID for threading
 * @property {number|null} timestamp - Unix seconds
 */
