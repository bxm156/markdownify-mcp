/**
 * `preinstall` hook: runs the platform setup script (setup.bat on Windows,
 * setup.sh elsewhere), which creates the project's Python .venv with
 * markitdown. It runs under plain Node before dependencies are installed, so
 * it may use only Node built-ins. execSync throws, and so fails the install,
 * only when the script exits non-zero.
 */
import { execSync } from 'child_process';

if (process.platform === 'win32') {
  execSync('setup.bat', { stdio: 'inherit' });
} else {
  execSync('./setup.sh', { stdio: 'inherit' });
}