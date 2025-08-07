import winston from "winston";
import logfmt from "logfmt";

const logfmtFormat = winston.format.printf((info) => {
  const { timestamp, level, message, ...meta } = info;
  const logData = {
    timestamp,
    level,
    message,
    ...meta,
  };
  return logfmt.stringify(logData);
});

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp(),
    logfmtFormat
  ),
  transports: [new winston.transports.Console()],
});
