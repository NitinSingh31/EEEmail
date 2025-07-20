const EmailService = require("./emailService");
const originalLog = console.log;
console.log = () => {};

describe("EmailService", () => {
  let emailService;

  beforeEach(() => {
    emailService = new EmailService({
      circuitBreaker: {
        coolDown: 1000,
      },
      backoffBase: 100,
    });
    emailService.rateCount = 0;
    emailService.rateResetTime = Date.now() + 60000;
  });

  afterEach(() => {
    if (emailService && emailService.queueInterval) {
      clearInterval(emailService.queueInterval);
    }
    if (emailService && emailService.stopProcessing) {
      emailService.stopProcessing();
    }
  });

  afterAll(() => {
    console.log = originalLog;
  });

  test("should send email successfully", async () => {
    jest
      .spyOn(emailService.providers[0], "send")
      .mockResolvedValue("Mocked success");

    const email = { to: "test@example.com", subject: "Test", body: "Hello" };
    const result = await emailService.sendEmail(email, "test-1");

    expect(result.status).toBe("sent");
    expect(result.trackingId).toBeDefined();
  }, 10000);

  test("should handle idempotency", async () => {
    jest
      .spyOn(emailService.providers[0], "send")
      .mockResolvedValue("Mocked success");

    const email = {
      to: "test@example.com",
      subject: "Idempotency",
      body: "Test",
    };
    const firstResult = await emailService.sendEmail(email, "idempotent-key");
    const secondResult = await emailService.sendEmail(email, "idempotent-key");

    expect(firstResult.trackingId).toBe(secondResult.trackingId);
  }, 10000);

  test("should switch providers on failure", async () => {
    jest
      .spyOn(emailService.providers[0], "send")
      .mockRejectedValue(new Error("Forced failure"));
    jest
      .spyOn(emailService.providers[1], "send")
      .mockResolvedValue("ProviderB success");

    const email = {
      to: "test@example.com",
      subject: "Provider Switch",
      body: "Test",
    };
    const result = await emailService.sendEmail(email, "switch-test");

    expect(result.provider).toBe("ProviderB");
  }, 10000);

  test("should respect rate limiting", async () => {
    jest
      .spyOn(emailService.providers[0], "send")
      .mockResolvedValue("Immediate success");

    const email = {
      to: "test@example.com",
      subject: "Rate Test",
      body: "Test",
    };

    emailService.rateCount = 10;

    const emailPromise = emailService.sendEmail(email, "rate-test-queued");

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(emailService.getQueueLength()).toBe(1);

    emailService.rateCount = 0;
    emailService.rateResetTime = Date.now() + 60000;

    const startTime = Date.now();
    while (emailService.getQueueLength() > 0) {
      if (Date.now() - startTime > 5000) {
        throw new Error("Queue processing took too long");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const result = await emailPromise;
    expect(result.status).toBe("sent");
  }, 20000);

  test("should trip circuit breaker", async () => {
    jest
      .spyOn(emailService.providers[0], "send")
      .mockRejectedValue(new Error("Forced failure"));
    jest
      .spyOn(emailService.providers[1], "send")
      .mockRejectedValue(new Error("Forced failure"));

    const email = {
      to: "test@example.com",
      subject: "Circuit Test",
      body: "Test",
    };

    const result = await emailService.sendEmail(email, "circuit-test");

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Circuit breaker tripped");
    expect(emailService.circuitBreaker.isOpen).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1200));
    emailService.resetCircuitBreakerIfNeeded();
    expect(emailService.circuitBreaker.isOpen).toBe(false);
  }, 15000);
});
