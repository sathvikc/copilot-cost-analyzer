/**
 * @fileoverview Typed message contracts for the postMessage RPC layer.
 *
 * Defines the request/response shapes for all messages exchanged between
 * the extension host and the webview. Used by rpc.js for type safety.
 */

/**
 * @typedef {'getSessions'|'getSessionDetail'|'getDashboard'|'getModelCatalog'|'getAgentResponses'|'getDiscoveryEvents'|'getTranscripts'|'triggerSync'|'exportSession'|'openDebugLog'|'showNotification'|'getSetupStatus'|'openCopilotDebugSetting'} RpcMethod
 */

/**
 * @typedef {Object} RpcRequest
 * @property {'rpc:request'} type
 * @property {string} id - Unique request ID
 * @property {RpcMethod} method
 * @property {Object} [params] - Method-specific parameters
 */

/**
 * @typedef {Object} RpcResponse
 * @property {'rpc:response'} type
 * @property {string} id - Matching request ID
 * @property {*} [result] - Successful response data
 * @property {{ message: string, code?: string }} [error] - Error details (if failed)
 */

/**
 * @typedef {Object} RpcNotification
 * @property {'rpc:notification'} type
 * @property {NotificationEvent} event - Event name
 * @property {*} [data] - Event-specific payload
 */

/**
 * @typedef {'syncComplete'|'loading'|'syncProgress'} NotificationEvent
 */

// Method parameter and return type contracts (for documentation/IDE hints)

/**
 * @typedef {Object} GetSessionDetailParams
 * @property {string} sessionId
 */

/**
 * @typedef {Object} ExportSessionParams
 * @property {string} sessionId
 * @property {'json'|'csv'|'markdown'} [format='json']
 * @property {{ includeTurns?: boolean, includeToolCalls?: boolean, includeLlmCalls?: boolean }} [options]
 */

/**
 * @typedef {Object} GetAgentResponsesParams
 * @property {string} sessionId
 */

/**
 * @typedef {Object} GetDiscoveryEventsParams
 * @property {string} sessionId
 */

/**
 * @typedef {Object} GetTranscriptsParams
 * @property {string} sessionId
 */

/**
 * @typedef {Object} OpenDebugLogParams
 * @property {string} filePath - Absolute path to the debug log file
 */

/**
 * @typedef {Object} ShowNotificationParams
 * @property {string} text - Notification message
 * @property {'info'|'error'} [level='info']
 */

// Message type constants
const RPC_REQUEST = 'rpc:request';
const RPC_RESPONSE = 'rpc:response';
const RPC_NOTIFICATION = 'rpc:notification';

module.exports = {
  RPC_REQUEST,
  RPC_RESPONSE,
  RPC_NOTIFICATION
};
