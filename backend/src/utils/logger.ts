// =============================================================================
// Structured JSON Logger
//
// Emits JSON log lines with: timestamp, level, correlationId, institution, message.
// Replaces console.log throughout the backend for consistent structured output.
//
// Usage:
//   import { logger } from '../utils/logger.js';
//   logger.info('something happened', { extra: 'data' });
//   logger.withCorrelationId('abc-123').info('correlated log');
// =============================================================================

import { config } from '../config.js';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  correlationId: string | null;
  institution: string;
  message: string;
  [key: string]: unknown;
}

class Logger {
  private correlationId: string | null;

  constructor(correlationId: string | null = null) {
    this.correlationId = correlationId;
  }

  /** Return a new Logger instance bound to a specific correlationId. */
  withCorrelationId(id: string): Logger {
    return new Logger(id);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.emit('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.emit('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.emit('error', message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.emit('debug', message, data);
  }

  private emit(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      correlationId: this.correlationId,
      institution: config.institutionName,
      message,
      ...data,
    };

    const line = JSON.stringify(entry);
    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

export const logger = new Logger();
