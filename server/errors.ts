export type ErrorKind =
  | 'auth'
  | 'forbidden'
  | 'notfound'
  | 'unreachable'
  | 'timeout'
  | 'missing-binary'
  | 'invalid'
  | 'protected'
  | 'command';

const STATUS: Record<ErrorKind, number> = {
  auth: 401,
  forbidden: 403,
  notfound: 404,
  unreachable: 502,
  timeout: 504,
  'missing-binary': 500,
  invalid: 400,
  protected: 409,
  command: 500,
};

export type ErrorParams = Record<string, string | number>;

export interface ErrorOptions {
  detail?: string;
  command?: string;
  params?: ErrorParams;
  /** Step of a multi-command flow that failed (e.g. adding an AKS cluster). */
  step?: string;
}

/**
 * `code` identifies the message so the UI can translate it; `message` is the
 * English fallback. Raw tool output (stderr) goes in `detail` and is never translated.
 */
export class AppError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly command: string;
  readonly params: ErrorParams;
  readonly step: string;

  constructor(
    readonly kind: ErrorKind,
    readonly code: string,
    message: string,
    opts: ErrorOptions = {},
  ) {
    super(message);
    this.status = STATUS[kind];
    this.detail = opts.detail ?? '';
    this.command = opts.command ?? '';
    this.params = opts.params ?? {};
    this.step = opts.step ?? '';
  }

  toJSON() {
    return {
      kind: this.kind,
      code: this.code,
      message: this.message,
      params: this.params,
      detail: this.detail,
      command: this.command,
      step: this.step || undefined,
    };
  }
}

export function invalid(code: string, message: string, params?: ErrorParams): AppError {
  return new AppError('invalid', code, message, { params });
}

// Ordered: the first matching rule wins. Auth rules come first because Azure
// token failures often also mention "Unauthorized" or "forbidden".
const RULES: Array<{ kind: ErrorKind; code: string; test: RegExp; message: string }> = [
  {
    kind: 'missing-binary',
    code: 'missingProgram',
    test: /is not recognized as an internal or external command|command not found/i,
    message: 'Program not found in PATH (for AKS clusters, install the Azure CLI "az").',
  },
  {
    kind: 'auth',
    code: 'azureLogin',
    test: /az login|AADSTS|kubelogin|devicelogin|AzureCLICredential|refresh token|token (has )?expired|interactive (login|authentication)/i,
    message: 'Azure session expired or not logged in. Run "az login" in a terminal and click Retry.',
  },
  {
    kind: 'auth',
    code: 'credentialsRejected',
    test: /Unauthorized|You must be logged in|provide credentials|getting credentials/i,
    message: 'The cluster rejected the credentials. Log in again (e.g. "az login") or check your kubeconfig.',
  },
  {
    kind: 'forbidden',
    code: 'forbidden',
    test: /forbidden|cannot (list|get|watch|patch|delete|create)/i,
    message: 'Your user is not allowed to perform this operation on this cluster.',
  },
  {
    kind: 'notfound',
    code: 'notFound',
    test: /NotFound|not found|doesn't have a resource type/i,
    message: 'Resource not found.',
  },
  {
    kind: 'unreachable',
    code: 'unreachable',
    test: /Unable to connect|connection refused|no such host|i\/o timeout|dial tcp|context deadline exceeded|TLS handshake timeout|EOF$/im,
    message: 'Could not reach the cluster. Is it running and reachable from this machine?',
  },
];

export function classifyStderr(stderr: string, command: string): AppError {
  const text = stderr.trim();
  for (const rule of RULES) {
    if (rule.test.test(text)) return new AppError(rule.kind, rule.code, rule.message, { detail: text, command });
  }
  // Unknown failure: the tool's own first line is the most useful message, untranslated.
  const line = firstLine(text);
  return line
    ? new AppError('command', 'raw', line, { detail: text, command })
    : new AppError('command', 'commandFailed', 'The command failed without a message.', { detail: text, command });
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  return line.replace(/^error:\s*/i, '').slice(0, 300);
}
