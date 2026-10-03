import json
import logging


class JSONFormatter(logging.Formatter):
    """Structured logging for production. Deliberately minimal --
    reuses the same fields the dev 'verbose' formatter already
    exposes (timestamp, level, logger name, message) plus exception
    info when present, rather than inventing a larger schema nothing
    downstream expects yet."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload)
