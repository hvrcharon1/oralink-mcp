import { createLogger, format, transports } from 'winston';
import { config } from './config.js';

const { combine, timestamp, errors, colorize, printf, json } = format;

const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ timestamp: ts, level, message, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} [${level}] ${message}${extra}`;
  }),
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json(),
);

export const logger = createLogger({
  level: config.logging.level,
  format: config.server.nodeEnv === 'development' ? devFormat : prodFormat,
  transports: [new transports.Console()],
});
