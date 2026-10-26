// Compatibility aliases for V1 integrations; model inference is not task execution.
export type {
  TaskExecutor as ModelProvider,
  TaskExecution as ProviderExecution,
} from "./task-executor.js";
