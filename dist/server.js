"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const app = (0, express_1.default)();
const PORT = 3000;
// Middleware to parse incoming JSON requests
app.use(express_1.default.json());
// Basic Route
app.get("/", (req, res) => {
    res.status(200).json({ message: "Hello from TypeScript Server!" });
});
// Start listening
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
