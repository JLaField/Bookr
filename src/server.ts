import express, { Application, Request, Response } from "express";

const app: Application = express();
const PORT = 3000;

// Middleware to parse incoming JSON requests
app.use(express.json());

// Basic Route
app.get("/", (req: Request, res: Response) => {
  res.status(200).json({ message: "Hello from TypeScript Server!" });
});

// Start listening
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
