# POS Restaurant Backend
A REST API backend for the POS Restaurant Workshop project, currently under improvement.

This project is used for learning backend development, API design, authentication, database management, and project refactoring.

## Tech Stack

- Node.js
- Express
- Prisma ORM
- PostgreSQL
- JWT Authentication

## Features

- User authentication
- Role-based authorization
- Food management
- Food type management
- Food size management
- Taste management
- Organization management
- Sales management
- Sales reports
- REST API

## Architecture

```text
Client
      ↓
REST API (Express)
      ↓
Controllers
      ↓
Prisma ORM
      ↓
PostgreSQL
```

## Getting Started

Install dependencies:

```bash
npm install
```

Generate Prisma Client:

```bash
npx prisma generate
```

Start the server:

```bash
node server.js
```

## Environment Variables

Create a local `.env` file.


