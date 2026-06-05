import path from "node:path";

export function resolveInsideWorkspace(cwd: string, requestedPath: string): string {
  const workspace = path.resolve(cwd);
  const resolved = path.resolve(workspace, requestedPath);
  // 当 HARNESS_FS_UNRESTRICTED=1 时放开沙箱：允许绝对路径与工作区之外的路径（整机访问）。
  if (process.env.HARNESS_FS_UNRESTRICTED === "1") {
    return resolved;
  }
  const relative = path.relative(workspace, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the workspace: ${requestedPath}`);
  }
  return resolved;
}

export function assertNotWorkspaceRoot(cwd: string, resolvedPath: string, operation: string): void {
  const workspace = path.resolve(cwd);
  if (path.resolve(resolvedPath) === workspace) {
    throw new Error(`Refusing to ${operation} the workspace root.`);
  }
}
