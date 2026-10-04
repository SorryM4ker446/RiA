// Shared recovery guidance contains no provider messages or submitted values.
export function executionGuidance(code: string | null): string {
  switch (code) {
    case "CONFIGURATION_ERROR": return "请在模型与用量中配置模型和密钥，再发起新的执行。";
    case "FORBIDDEN": case "UNAUTHORIZED": return "请检查访问凭证或重新授权目录；文件写入仍需重新批准。";
    case "UPSTREAM_FAILED": case "MODEL_UNAVAILABLE": return "模型服务不可用，请检查网络和模型配置后重试。";
    case "TIMEOUT": case "ABORTED": return "请求超时或已取消，请检查网络；新的模型请求可能再次计费。";
    case "SERVICE_UNAVAILABLE": return "工作区正在恢复或数据库忙，请等待操作结束后刷新。";
    case "INTERRUPTED": case "interrupted-by-restart": return "应用退出前执行未完成。请先核对会话、任务和备份；应用不会自动重放写入。";
    case "step-budget": case "failure-budget": case "cost-budget": case "deadline-exceeded": return "执行已达到设置的上限，请核对已完成步骤，再明确发起新的请求。";
    case "UNSUPPORTED_KIND": return "此版本不支持该任务类型，请检查计划配置。";
    default: return "请核对已有结果并导出诊断信息；工具操作需要重新发起并重新批准。";
  }
}
