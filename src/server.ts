import express, { Application, Request, Response } from "express";
import { Client } from "@hubspot/api-client";

const app: Application = express();
const PORT = 8080;

// Fetch the service key from the Cloud Run environment variable
const hubspotKey = process.env.HUBSPOT_KEY;

if (!hubspotKey) {
  throw new Error("Missing HUBSPOT_KEY environment variable.");
}

// Middleware to parse incoming JSON requests
app.use(express.json());

// Initialize the HubSpot client using the Service Key as the accessToken
const hubspotClient = new Client({ accessToken: hubspotKey });

async function getContacts() {
  try {
    // Make your REST API call via the SDK client
    const response = await hubspotClient.crm.contacts.basicApi.getPage(10);
    return response.results;
  } catch (error) {
    console.error("Error fetching HubSpot data:", error);
    throw error;
  }
}

// Basic Route
app.get("/", (req: Request, res: Response) => {
  res.status(200).json({ message: "Hello from TypeScript Server!" });
});

app.get("/contacts", async (req: Request, res: Response) => {
  const result = await getContacts();
  if (result !== undefined) {
    // The function explicitly returned something
    res.status(200).json({ message: result });
  }
});

// Start listening
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
