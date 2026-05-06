/**
 * 机器码重置模块
 * 参考实现: windsurf-account-manager (Tauri) + wf-dialog-mcp
 *
 * 目标: 让 Windsurf 服务端认为是新设备
 *
 * 范围 (本模块):
 * - storage.json 遥测 ID (双位置: 根 + User/globalStorage)
 * - Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid (需管理员)
 * - Linux: /etc/machine-id + /var/lib/dbus/machine-id + 缓存 (需 sudo)
 * - macOS: 清理软件层缓存 (硬件 UUID 无法修改)
 *
 * 补丁部分 (windsurfPatch.ts):
 * - generateFingerprint: 注入 early return 返回固定随机指纹
 * - getOrGenerateInstallationId: 注入 early return 返回固定随机 UUID
 * - 补丁改的是磁盘文件, 需要重启 Windsurf 才生效 → viewProvider 重置后弹窗提示重启
 *
 * 开发者: Ti
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { log } from './logger';
import { MachineIdInfo, MachineIdResetResult, MachineIdResetStep } from './types';

const TAG = 'MachineId';

export class MachineIdManager {
  /**
   * 执行完整的机器码重置, 每步独立失败不中断后续
   * @returns 结构化结果, 前端可按 steps 展示每一步状态
   */
  async resetAll(): Promise<MachineIdResetResult> {
    log('info', TAG, '========== 开始重置机器码 ==========');
    const steps: MachineIdResetStep[] = [];

    /* 1. storage.json 遥测 ID (双位置) */
    steps.push(...await this.resetStorageJson());

    /* 2. 平台特定 */
    if (process.platform === 'win32') {
      steps.push(await this.resetWindowsMachineGuid());
    } else if (process.platform === 'linux') {
      steps.push(...await this.resetLinuxMachineId());
    } else if (process.platform === 'darwin') {
      steps.push(...await this.resetMacOSCaches());
    }

    const successCount = steps.filter(s => s.success).length;
    const allSuccess = steps.length > 0 && successCount === steps.length;
    const requiresAdminHint = steps.some(s =>
      !s.success && !!s.error && /拒绝|denied|权限|Access is denied|EACCES|EPERM/i.test(s.error)
    );

    log('info', TAG, `========== 重置完成 | 成功 ${successCount}/${steps.length} ==========`);

    return { success: allSuccess, steps, requiresAdminHint };
  }

  /** 获取当前机器码信息 (用于 UI 展示) */
  async getMachineIdInfo(): Promise<MachineIdInfo> {
    const info: MachineIdInfo = {};

    /* 从任意一个存在的 storage.json 读取即可, 两份内容应保持一致 */
    for (const p of this.getStorageJsonPaths()) {
      if (!fs.existsSync(p)) { continue; }
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        info.telemetryMachineId = data['telemetry.machineId'] || info.telemetryMachineId;
        info.installationId = data['telemetry.devDeviceId'] || info.installationId;
        break;
      } catch { /* 忽略 */ }
    }

    if (process.platform === 'win32') {
      try {
        info.machineId = await this.readWindowsMachineGuid();
      } catch { /* 忽略 */ }
    }

    return info;
  }

  /* ========== 内部实现 ========== */

  /** Windsurf 用户数据目录 */
  private getUserDataDir(): string {
    if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || '', 'Windsurf');
    } else if (process.platform === 'darwin') {
      return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Windsurf');
    }
    return path.join(process.env.HOME || '', '.config', 'Windsurf');
  }

  /** 两个候选 storage.json 位置: 根目录 + User/globalStorage */
  private getStorageJsonPaths(): string[] {
    const userData = this.getUserDataDir();
    return [
      path.join(userData, 'storage.json'),
      path.join(userData, 'User', 'globalStorage', 'storage.json'),
    ];
  }

  /**
   * 生成对齐 VSCode/Windsurf 原生格式的遥测 ID
   * - machineId:    64 字符 hex (256 bit)  ← VSCode 原生是这个长度
   * - macMachineId: 32 字符 hex (128 bit)  ← MD5 风格
   * - devDeviceId:  小写 UUID 36 字符
   * - sqmId:        带大括号的大写 UUID, 如 "{ABCDEF12-...}"
   *                 注: Tauri 项目这里漏了大括号, wf-dialog-mcp 带大括号是对的
   */
  private generateTelemetryIds() {
    return {
      machineId: crypto.randomBytes(32).toString('hex'),
      macMachineId: crypto.randomBytes(16).toString('hex'),
      devDeviceId: crypto.randomUUID(),
      sqmId: '{' + crypto.randomUUID().toUpperCase() + '}',
    };
  }

  /** 向两个 storage.json 位置写入新遥测 ID, 每个位置独立成 step */
  private async resetStorageJson(): Promise<MachineIdResetStep[]> {
    const ids = this.generateTelemetryIds();
    const results: MachineIdResetStep[] = [];

    for (const storagePath of this.getStorageJsonPaths()) {
      const label = storagePath.includes('globalStorage')
        ? 'storage.json (globalStorage)'
        : 'storage.json (root)';

      if (!fs.existsSync(storagePath)) {
        results.push({ name: label, success: true, value: '跳过: 文件不存在', path: storagePath });
        continue;
      }

      try {
        /* 尝试解除只读 (某些 Windsurf 版本会把 storage.json 设为 0o444) */
        try { fs.chmodSync(storagePath, 0o644); } catch { /* 非致命 */ }

        const raw = fs.readFileSync(storagePath, 'utf-8');
        const data = raw.trim() ? JSON.parse(raw) : {};

        data['telemetry.machineId'] = ids.machineId;
        data['telemetry.macMachineId'] = ids.macMachineId;
        data['telemetry.devDeviceId'] = ids.devDeviceId;
        data['telemetry.sqmId'] = ids.sqmId;

        fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), 'utf-8');

        results.push({
          name: label,
          success: true,
          value: ids.machineId.substring(0, 16) + '...',
          path: storagePath,
        });
        log('info', TAG, `${label} 已重置: ${storagePath}`);
      } catch (err: any) {
        results.push({
          name: label,
          success: false,
          path: storagePath,
          error: err.message,
        });
        log('error', TAG, `${label} 重置失败 (${storagePath}): ${err.message}`);
      }
    }

    return results;
  }

  /** Windows: 写 HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid (需管理员) */
  private async resetWindowsMachineGuid(): Promise<MachineIdResetStep> {
    return new Promise((resolve) => {
      /* 注: Tauri 项目这里也不带大括号, 跟 HKLM 原生一致 */
      const newGuid = crypto.randomUUID().toUpperCase();
      const cmd = `reg add "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid /t REG_SZ /d "${newGuid}" /f`;

      exec(cmd, (err, _stdout, stderr) => {
        if (err) {
          const raw = (stderr || err.message).trim();
          const isPerm = /拒绝|denied|Access is denied/i.test(raw);
          const error = isPerm ? '权限不足, 请以管理员身份运行 Windsurf 后重试' : raw;
          log('error', TAG, `HKLM MachineGuid 写入失败: ${raw}`);
          resolve({ name: 'HKLM\\...\\MachineGuid', success: false, error });
        } else {
          log('info', TAG, `HKLM MachineGuid 已更新: ${newGuid}`);
          resolve({ name: 'HKLM\\...\\MachineGuid', success: true, value: newGuid });
        }
      });
    });
  }

  /** Windows: 读取当前 MachineGuid */
  private async readWindowsMachineGuid(): Promise<string> {
    return new Promise((resolve, reject) => {
      exec('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', (err, stdout) => {
        if (err) { reject(err); return; }
        const m = stdout.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
        resolve(m ? m[1] : 'unknown');
      });
    });
  }

  /** Linux: /etc/machine-id + /var/lib/dbus/machine-id + Windsurf 缓存 */
  private async resetLinuxMachineId(): Promise<MachineIdResetStep[]> {
    const steps: MachineIdResetStep[] = [];
    const newId = crypto.randomBytes(16).toString('hex');

    /* 直写失败自动尝试 sudo -n (非交互式, 无法输密码就失败) */
    const writeWithSudo = (filePath: string): Promise<MachineIdResetStep> => {
      return new Promise((resolve) => {
        fs.writeFile(filePath, newId + '\n', (err) => {
          if (!err) {
            log('info', TAG, `${filePath} 直写成功`);
            resolve({ name: filePath, success: true, value: newId });
            return;
          }
          exec(`sudo -n bash -c "echo '${newId}' > ${filePath}"`, (e2) => {
            if (e2) {
              const errMsg = `${err.message} | sudo 降级失败: ${e2.message}`;
              log('warn', TAG, `${filePath} 重置失败: ${errMsg}`);
              resolve({ name: filePath, success: false, error: errMsg });
            } else {
              log('info', TAG, `${filePath} 通过 sudo 重置成功`);
              resolve({ name: filePath, success: true, value: newId });
            }
          });
        });
      });
    };

    if (fs.existsSync('/etc/machine-id')) {
      steps.push(await writeWithSudo('/etc/machine-id'));
    }

    const dbusPath = '/var/lib/dbus/machine-id';
    if (fs.existsSync(dbusPath)) {
      try {
        /* 如果是 symlink 通常指向 /etc/machine-id, 改前者已经够了 */
        if (!fs.lstatSync(dbusPath).isSymbolicLink()) {
          steps.push(await writeWithSudo(dbusPath));
        }
      } catch { /* lstat 失败视为不可操作 */ }
    }

    /* Windsurf 本地缓存 (如果存在) */
    const home = process.env.HOME || '';
    const cachePaths = [
      path.join(home, '.config', 'Windsurf', 'machineid'),
      path.join(home, '.local', 'share', 'Windsurf', '.installerId'),
    ];
    for (const cp of cachePaths) {
      if (!fs.existsSync(cp)) { continue; }
      try {
        fs.unlinkSync(cp);
        steps.push({ name: cp, success: true, value: '已删除' });
        log('info', TAG, `缓存文件已删除: ${cp}`);
      } catch (e: any) {
        steps.push({ name: cp, success: false, error: e.message });
        log('warn', TAG, `缓存文件删除失败: ${cp} - ${e.message}`);
      }
    }

    return steps;
  }

  /** macOS: 硬件 UUID 不可改, 仅清理 Windsurf 软件层缓存 */
  private async resetMacOSCaches(): Promise<MachineIdResetStep[]> {
    const steps: MachineIdResetStep[] = [];
    const home = process.env.HOME || '';
    const cachePaths = [
      path.join(home, '.config', 'Windsurf', 'machineid'),
      path.join(home, 'Library', 'Application Support', 'Windsurf', '.installerId'),
    ];

    for (const cp of cachePaths) {
      if (!fs.existsSync(cp)) { continue; }
      try {
        fs.unlinkSync(cp);
        steps.push({ name: cp, success: true, value: '已删除' });
        log('info', TAG, `缓存文件已删除: ${cp}`);
      } catch (e: any) {
        steps.push({ name: cp, success: false, error: e.message });
        log('warn', TAG, `缓存文件删除失败: ${cp} - ${e.message}`);
      }
    }

    if (steps.length === 0) {
      steps.push({
        name: 'macOS 缓存',
        success: true,
        value: '无需清理的缓存文件',
      });
    }

    return steps;
  }
}
