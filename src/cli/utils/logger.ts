/**
 * Console output with ANSI colors (no external dependencies)
 */

const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

export function success(msg: string): void {
  console.log(`${colors.green}  +${colors.reset} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${colors.yellow}  ~${colors.reset} ${msg}`);
}

export function info(msg: string): void {
  console.log(`${colors.blue}  i${colors.reset} ${msg}`);
}

export function error(msg: string): void {
  console.log(`${colors.red}  x${colors.reset} ${msg}`);
}

export function skip(msg: string): void {
  console.log(`${colors.gray}  -${colors.reset} ${msg}`);
}

export function header(msg: string): void {
  console.log(`\n${colors.bold}${msg}${colors.reset}`);
}

export function blank(): void {
  console.log('');
}
