const fs = require("fs");
const path = require("path");

const mockProviders = [
  {
    name: "ProviderA",
    send: (email) => {
      if (Math.random() < 0.3) throw new Error("Provider A failed");
      return `Email sent by provider A ${email.subject}`;
    },
  },
  {
    name: "ProviderB",
    send: (email) => {
      if (Math.random() > 0.2) throw new Error("Provider B failed");
      return `Email sent by provider B ${email.subject}`;
    },
  },
];

class EmailService {
  constructor(config = {}) {
    this.providers = mockProviders;
    this.activeProviderIndex = 0;
    this.rateLimit = 10;
    this.rateCount = 0;
    this.rateResetTime = Date.now() + 60000;
    this.idempotencyCache = new Map();
    this.statusMap = new Map();
    this.queue = [];
    this.circuitBreaker = {
      failures: 0,
      threshold: 3,
      isOpen: false,
      coolDown: 30000,
      ...(config.circuitBreaker || {}),
    };

    this.backoffBase = config.backoffBase || 1000;

    this.queueInterval = setInterval(() => this.processQueue(), 100);
  }

  logToFile(data) {
    const logPath = path.join(__dirname, "email.log");
    const logEntry = `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`;

    fs.appendFile(logPath, logEntry, (err) => {
      if (err) console.error("Failed to log email:", err);
    });
  }

  async sendEmail(email, idempotencyKey) {
    if (idempotencyKey && this.idempotencyCache.has(idempotencyKey)) {
      return this.idempotencyCache.get(idempotencyKey);
    }

    const trackingId = `email-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    this.statusMap.set(trackingId, {
      status: "queued",
      attempts: 0,
      createdAt: Date.now(),
    });

    return new Promise((resolve) => {
      this.queue.push({ email, idempotencyKey, trackingId, resolve });
    });
  }

  async processQueue() {
    if (Date.now() > this.rateResetTime) {
      this.rateCount = 0;
      this.rateResetTime = Date.now() + 60000;
    }

    if (this.queue.length > 0 && this.rateCount < this.rateLimit) {
      const task = this.queue.shift();
      this.rateCount++;

      try {
        const prev = this.statusMap.get(task.trackingId) || {};

        this.statusMap.set(task.trackingId, {
          ...prev,
          status: "sending",
        });

        const result = await this.attemptSend(task.email, task.trackingId);

        const prevStatus = this.statusMap.get(task.trackingId) || {};
        const successStatus = {
          ...prevStatus,
          status: "sent",
          provider: result.provider,
          sentAt: Date.now(),
        };

        this.statusMap.set(task.trackingId, successStatus);
        this.logToFile({ trackingId: task.trackingId, ...successStatus });

        if (task.idempotencyKey) {
          this.idempotencyCache.set(task.idempotencyKey, {
            trackingId: task.trackingId,
            ...successStatus,
          });
        }

        task.resolve({ trackingId: task.trackingId, ...successStatus });
      } catch (error) {
        const prev = this.statusMap.get(task.trackingId) || {};
        const failStatus = {
          ...prev,
          status: "failed",
          error: error.message,
        };

        this.statusMap.set(task.trackingId, failStatus);
        this.logToFile({ trackingId: task.trackingId, ...failStatus });
        task.resolve({ trackingId: task.trackingId, ...failStatus });
      }
    }
  }

  resetCircuitBreakerIfNeeded() {
    if (this.circuitBreaker.isOpen && this.circuitBreaker.lastFailureTime) {
      if (
        Date.now() - this.circuitBreaker.lastFailureTime >
        this.circuitBreaker.coolDown
      ) {
        this.circuitBreaker.isOpen = false;
        this.circuitBreaker.failures = 0;
        this.circuitBreaker.lastFailureTime = null;
      }
    }
  }

  async attemptSend(email, trackingId) {
    let attempts = 0;
    let lastError;

    while (attempts < 3) {
      attempts++;

      this.resetCircuitBreakerIfNeeded();

      if (this.circuitBreaker.isOpen) {
        throw new Error("Circuit breaker tripped");
      }

      try {
        this.statusMap.set(trackingId, {
          ...this.statusMap.get(trackingId),
          attempts,
        });

        const provider = this.providers[this.activeProviderIndex];
        const result = await provider.send(email);
        this.circuitBreaker.failures = 0;
        return { result, provider: provider.name };
      } catch (error) {
        lastError = error;
        this.circuitBreaker.failures++;

        if (this.circuitBreaker.failures >= this.circuitBreaker.threshold) {
          this.circuitBreaker.isOpen = true;
          this.circuitBreaker.lastFailureTime = Date.now();
          throw new Error("Circuit breaker tripped");
        }

        this.activeProviderIndex =
          (this.activeProviderIndex + 1) % this.providers.length;

        const delay = this.backoffBase * Math.pow(2, attempts);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  getStatus(trackingId) {
    return this.statusMap.get(trackingId) || { error: "invalid trackingId" };
  }

  getQueueLength() {
    return this.queue.length;
  }
  stopProcessing() {
    if (this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
    }
  }
}

module.exports = EmailService;
