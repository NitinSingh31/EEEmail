const express = require("express");
const EmailService = require("./emailService");

const app = express();
app.use(express.json());

const emailService = new EmailService();
const port = process.env.PORT || 3000;

app.post("/send", async (req, res) => {
  const { to, subject, body, idempotencyKey } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: "missing required fields" });
  }

  const result = await emailService.sendEmail(
    { to, subject, body },
    idempotencyKey
  );
  res.json(result);
});

app.get("/status/:id", (req, res) => {
  const status = emailService.getStatus(req.params.id);
  res.json(status);
});

app.get("/", (req, res) => {
  res.send("EmailService is up and running!");
});

app.listen(port, () => {
  console.log("server running on port 3000");
});
