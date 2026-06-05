import { stat } from "node:fs/promises";
import path from "node:path";
import { applyEnvValues, writeEnvValues } from "./model-config.js";

export interface WorkspaceConfigInput {
  workspace?: string;
  unrestricted?: boolean;
}

export interface WorkspaceConfig {
  workspace: string;
  unrestricted: boolean;
}

/** 读取当前生效的工作区配置。workspace 未设置时回落到启动目录。 */
export function currentWorkspaceConfig(defaultCwd: string): WorkspaceConfig {
  const raw = process.env.HARNESS_WORKSPACE?.trim();
  return {
    workspace: raw ? path.resolve(raw) : path.resolve(defaultCwd),
    unrestricted: process.env.HARNESS_FS_UNRESTRICTED === "1",
  };
}

/** 校验并保存工作区配置到 .env，同时实时生效到 process.env。 */
export async function saveWorkspaceConfig(
  cwd: string,
  input: WorkspaceConfigInput,
): Promise<WorkspaceConfig> {
  const requested = input.workspace?.trim();
  const workspace = requested ? path.resolve(requested) : path.resolve(cwd);

  let info;
  try {
    info = await stat(workspace);
  } catch {
    throw new Error(`工作区目录不存在：${workspace}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`工作区路径不是文件夹：${workspace}`);
  }

  const unrestricted = input.unrestricted ? "1" : "0";
  const values: Record<string, string> = {
    HARNESS_WORKSPACE: workspace,
    HARNESS_FS_UNRESTRICTED: unrestricted,
  };

  applyEnvValues(values);
  await writeEnvValues(path.join(cwd, ".env"), values);

  return { workspace, unrestricted: unrestricted === "1" };
}
