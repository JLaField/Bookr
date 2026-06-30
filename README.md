# Bookr

Integrates call data from a Retell agent to HubSpot CRM

## Description

This project is intended to serve as a bridge between a Retell Agent and Hubspot CRM for a fictitious painting company. The Retell Agent is setup to book appointments for painting estimates. This project is utilizes the "call" object from Retell's call_analyzed event to create a contact and meeting in HubSpot using a HTTP POST endpoint. It also provides a read endpoint for all contacts in the company's HubSpot.

This project is deployed to Google Cloud run, and the contact read endpoint is accessible at https://bookr-144109414225.us-west1.run.app/contacts.

The meeting read endpoint is available at https://bookr-144109414225.us-west1.run.app/meetings.

## Important Notes

This project is a work in progress, has not been thoroughly tested, and has known issues.

Known issues:

- Meeting creation in HubSpot does not utilize the preferred appointment time from the client's phone call; instead defaults to the time the call was placed at
