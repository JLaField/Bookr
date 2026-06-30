# Bookr

Integrates call data from a Retell agent to HubSpot CRM

## Description

This project is intended to serve as a bridge between a Retell Agent and Hubspot CRM for a fictitious painting company. The Retell Agent is setup to book appointments for painting estimates. This project is utilizes the "call" object from Retell's call_analyzed event to create a contact and meeting in HubSpot using a HTTP POST endpoint. It also provides a read endpoint for all contacts in the company's HubSpot.

This project is deployed to Google Cloud run, and the read endpoint is accessible at https://bookr-144109414225.us-west1.run.app/contacts.

## Important Notes

This project is a work in progress and not functional as-is.

Known issues:

- Multiple identical contacts created from the same call
- Unable to create meetings in HubSpot due to API permissions
