import type { BenchTask, GradeCommand } from "./tasks.js";

import { SCALE_TASKS } from "./scale-tasks.js";

export const scale6 = {
  id: "scale-validators-6",
  title: "6 independent validation modules",
  category: "implementation",
  tier: "scale",
  rationale: "Scalable fixture for 6 streams.",
  requiresGit: true,
  streams: 6,
  immutable: [
    "test/val_email.test.mjs",
    "test/val_uuid.test.mjs",
    "test/val_ipv4.test.mjs",
    "test/val_ipv6.test.mjs",
    "test/val_mac.test.mjs",
    "test/val_hex.test.mjs",
  ],
  files: {
    "package.json":
      '{\n  "name": "validators",\n  "private": true,\n  "type": "module"\n}\n',
    "src/val_email.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_email.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_email.mjs";\n\ntest("validate val_email", () => {\n  assert.equal(validate(\'test@example.com\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_uuid.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_uuid.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_uuid.mjs";\n\ntest("validate val_uuid", () => {\n  assert.equal(validate(\'123e4567-e89b-12d3-a456-426614174000\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_ipv4.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_ipv4.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_ipv4.mjs";\n\ntest("validate val_ipv4", () => {\n  assert.equal(validate(\'192.168.1.1\'), true); assert.equal(validate(\'256.0.0.1\'), false);\n});\n',
    "src/val_ipv6.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_ipv6.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_ipv6.mjs";\n\ntest("validate val_ipv6", () => {\n  assert.equal(validate(\'2001:0db8:85a3:0000:0000:8a2e:0370:7334\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_mac.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_mac.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_mac.mjs";\n\ntest("validate val_mac", () => {\n  assert.equal(validate(\'00:1A:2B:3C:4D:5E\'), true); assert.equal(validate(\'00-1A\'), false);\n});\n',
    "src/val_hex.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_hex.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_hex.mjs";\n\ntest("validate val_hex", () => {\n  assert.equal(validate(\'#a3c113\'), true); assert.equal(validate(\'a3c113\'), false);\n});\n',
  },
  objective:
    "This project has 6 unimplemented validation modules. Each has a test file that fully specifies its behaviour. None imports another.\n\nImplement all 6 so that every test passes. Do not modify any file under test/.\n\nVerify with:\n  node --test test/val_email.test.mjs test/val_uuid.test.mjs test/val_ipv4.test.mjs test/val_ipv6.test.mjs test/val_mac.test.mjs test/val_hex.test.mjs",
  grade: [
    {
      file: process.execPath,
      args: [
        "--test",
        "test/val_email.test.mjs",
        "test/val_uuid.test.mjs",
        "test/val_ipv4.test.mjs",
        "test/val_ipv6.test.mjs",
        "test/val_mac.test.mjs",
        "test/val_hex.test.mjs",
      ],
      label: "all 6 test suites pass",
    },
  ],
} as BenchTask;

export const scale12 = {
  id: "scale-validators-12",
  title: "12 independent validation modules",
  category: "implementation",
  tier: "scale",
  rationale: "Scalable fixture for 12 streams.",
  requiresGit: true,
  streams: 12,
  immutable: [
    "test/val_email.test.mjs",
    "test/val_uuid.test.mjs",
    "test/val_ipv4.test.mjs",
    "test/val_ipv6.test.mjs",
    "test/val_mac.test.mjs",
    "test/val_hex.test.mjs",
    "test/val_credit.test.mjs",
    "test/val_isbn.test.mjs",
    "test/val_url.test.mjs",
    "test/val_phone.test.mjs",
    "test/val_postal.test.mjs",
    "test/val_semver.test.mjs",
  ],
  files: {
    "package.json":
      '{\n  "name": "validators",\n  "private": true,\n  "type": "module"\n}\n',
    "src/val_email.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_email.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_email.mjs";\n\ntest("validate val_email", () => {\n  assert.equal(validate(\'test@example.com\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_uuid.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_uuid.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_uuid.mjs";\n\ntest("validate val_uuid", () => {\n  assert.equal(validate(\'123e4567-e89b-12d3-a456-426614174000\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_ipv4.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_ipv4.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_ipv4.mjs";\n\ntest("validate val_ipv4", () => {\n  assert.equal(validate(\'192.168.1.1\'), true); assert.equal(validate(\'256.0.0.1\'), false);\n});\n',
    "src/val_ipv6.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_ipv6.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_ipv6.mjs";\n\ntest("validate val_ipv6", () => {\n  assert.equal(validate(\'2001:0db8:85a3:0000:0000:8a2e:0370:7334\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_mac.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_mac.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_mac.mjs";\n\ntest("validate val_mac", () => {\n  assert.equal(validate(\'00:1A:2B:3C:4D:5E\'), true); assert.equal(validate(\'00-1A\'), false);\n});\n',
    "src/val_hex.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_hex.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_hex.mjs";\n\ntest("validate val_hex", () => {\n  assert.equal(validate(\'#a3c113\'), true); assert.equal(validate(\'a3c113\'), false);\n});\n',
    "src/val_credit.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_credit.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_credit.mjs";\n\ntest("validate val_credit", () => {\n  assert.equal(validate(\'4532134567890123\'), true); assert.equal(validate(\'123\'), false);\n});\n',
    "src/val_isbn.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_isbn.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_isbn.mjs";\n\ntest("validate val_isbn", () => {\n  assert.equal(validate(\'978-3-16-148410-0\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_url.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_url.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_url.mjs";\n\ntest("validate val_url", () => {\n  assert.equal(validate(\'https://www.example.com\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_phone.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_phone.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_phone.mjs";\n\ntest("validate val_phone", () => {\n  assert.equal(validate(\'+14155552671\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_postal.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_postal.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_postal.mjs";\n\ntest("validate val_postal", () => {\n  assert.equal(validate(\'12345-6789\'), true); assert.equal(validate(\'1234\'), false);\n});\n',
    "src/val_semver.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_semver.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_semver.mjs";\n\ntest("validate val_semver", () => {\n  assert.equal(validate(\'1.2.3-alpha.1\'), true); assert.equal(validate(\'1.2\'), false);\n});\n',
  },
  objective:
    "This project has 12 unimplemented validation modules. Each has a test file that fully specifies its behaviour. None imports another.\n\nImplement all 12 so that every test passes. Do not modify any file under test/.\n\nVerify with:\n  node --test test/val_email.test.mjs test/val_uuid.test.mjs test/val_ipv4.test.mjs test/val_ipv6.test.mjs test/val_mac.test.mjs test/val_hex.test.mjs test/val_credit.test.mjs test/val_isbn.test.mjs test/val_url.test.mjs test/val_phone.test.mjs test/val_postal.test.mjs test/val_semver.test.mjs",
  grade: [
    {
      file: process.execPath,
      args: [
        "--test",
        "test/val_email.test.mjs",
        "test/val_uuid.test.mjs",
        "test/val_ipv4.test.mjs",
        "test/val_ipv6.test.mjs",
        "test/val_mac.test.mjs",
        "test/val_hex.test.mjs",
        "test/val_credit.test.mjs",
        "test/val_isbn.test.mjs",
        "test/val_url.test.mjs",
        "test/val_phone.test.mjs",
        "test/val_postal.test.mjs",
        "test/val_semver.test.mjs",
      ],
      label: "all 12 test suites pass",
    },
  ],
} as BenchTask;

export const scale20 = {
  id: "scale-validators-20",
  title: "20 independent validation modules",
  category: "implementation",
  tier: "scale",
  rationale: "Scalable fixture for 20 streams.",
  requiresGit: true,
  streams: 20,
  immutable: [
    "test/val_email.test.mjs",
    "test/val_uuid.test.mjs",
    "test/val_ipv4.test.mjs",
    "test/val_ipv6.test.mjs",
    "test/val_mac.test.mjs",
    "test/val_hex.test.mjs",
    "test/val_credit.test.mjs",
    "test/val_isbn.test.mjs",
    "test/val_url.test.mjs",
    "test/val_phone.test.mjs",
    "test/val_postal.test.mjs",
    "test/val_semver.test.mjs",
    "test/val_jwt.test.mjs",
    "test/val_base64.test.mjs",
    "test/val_slug.test.mjs",
    "test/val_lat.test.mjs",
    "test/val_long.test.mjs",
    "test/val_btc.test.mjs",
    "test/val_eth.test.mjs",
    "test/val_date.test.mjs",
  ],
  files: {
    "package.json":
      '{\n  "name": "validators",\n  "private": true,\n  "type": "module"\n}\n',
    "src/val_email.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_email.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_email.mjs";\n\ntest("validate val_email", () => {\n  assert.equal(validate(\'test@example.com\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_uuid.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_uuid.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_uuid.mjs";\n\ntest("validate val_uuid", () => {\n  assert.equal(validate(\'123e4567-e89b-12d3-a456-426614174000\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_ipv4.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_ipv4.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_ipv4.mjs";\n\ntest("validate val_ipv4", () => {\n  assert.equal(validate(\'192.168.1.1\'), true); assert.equal(validate(\'256.0.0.1\'), false);\n});\n',
    "src/val_ipv6.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_ipv6.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_ipv6.mjs";\n\ntest("validate val_ipv6", () => {\n  assert.equal(validate(\'2001:0db8:85a3:0000:0000:8a2e:0370:7334\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_mac.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_mac.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_mac.mjs";\n\ntest("validate val_mac", () => {\n  assert.equal(validate(\'00:1A:2B:3C:4D:5E\'), true); assert.equal(validate(\'00-1A\'), false);\n});\n',
    "src/val_hex.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_hex.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_hex.mjs";\n\ntest("validate val_hex", () => {\n  assert.equal(validate(\'#a3c113\'), true); assert.equal(validate(\'a3c113\'), false);\n});\n',
    "src/val_credit.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_credit.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_credit.mjs";\n\ntest("validate val_credit", () => {\n  assert.equal(validate(\'4532134567890123\'), true); assert.equal(validate(\'123\'), false);\n});\n',
    "src/val_isbn.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_isbn.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_isbn.mjs";\n\ntest("validate val_isbn", () => {\n  assert.equal(validate(\'978-3-16-148410-0\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_url.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_url.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_url.mjs";\n\ntest("validate val_url", () => {\n  assert.equal(validate(\'https://www.example.com\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_phone.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_phone.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_phone.mjs";\n\ntest("validate val_phone", () => {\n  assert.equal(validate(\'+14155552671\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_postal.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_postal.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_postal.mjs";\n\ntest("validate val_postal", () => {\n  assert.equal(validate(\'12345-6789\'), true); assert.equal(validate(\'1234\'), false);\n});\n',
    "src/val_semver.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_semver.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_semver.mjs";\n\ntest("validate val_semver", () => {\n  assert.equal(validate(\'1.2.3-alpha.1\'), true); assert.equal(validate(\'1.2\'), false);\n});\n',
    "src/val_jwt.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_jwt.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_jwt.mjs";\n\ntest("validate val_jwt", () => {\n  assert.equal(validate(\'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.x\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_base64.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_base64.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_base64.mjs";\n\ntest("validate val_base64", () => {\n  assert.equal(validate(\'SGVsbG8gd29ybGQ=\'), true); assert.equal(validate(\'!\'), false);\n});\n',
    "src/val_slug.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_slug.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_slug.mjs";\n\ntest("validate val_slug", () => {\n  assert.equal(validate(\'my-cool-post-123\'), true); assert.equal(validate(\'My Post\'), false);\n});\n',
    "src/val_lat.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_lat.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_lat.mjs";\n\ntest("validate val_lat", () => {\n  assert.equal(validate(\'90.0\'), true); assert.equal(validate(\'91.0\'), false);\n});\n',
    "src/val_long.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_long.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_long.mjs";\n\ntest("validate val_long", () => {\n  assert.equal(validate(\'180.0\'), true); assert.equal(validate(\'181.0\'), false);\n});\n',
    "src/val_btc.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_btc.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_btc.mjs";\n\ntest("validate val_btc", () => {\n  assert.equal(validate(\'1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_eth.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_eth.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_eth.mjs";\n\ntest("validate val_eth", () => {\n  assert.equal(validate(\'0x32Be343B94f860124dC4fEe278FDCBD38C102D88\'), true); assert.equal(validate(\'invalid\'), false);\n});\n',
    "src/val_date.mjs":
      "// Implement validate(input).\nexport function validate(input) { return false; }\n",
    "test/val_date.test.mjs":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { validate } from "../src/val_date.mjs";\n\ntest("validate val_date", () => {\n  assert.equal(validate(\'2023-01-01T12:00:00Z\'), true); assert.equal(validate(\'2023-13-01\'), false);\n});\n',
  },
  objective:
    "This project has 20 unimplemented validation modules. Each has a test file that fully specifies its behaviour. None imports another.\n\nImplement all 20 so that every test passes. Do not modify any file under test/.\n\nVerify with:\n  node --test test/val_email.test.mjs test/val_uuid.test.mjs test/val_ipv4.test.mjs test/val_ipv6.test.mjs test/val_mac.test.mjs test/val_hex.test.mjs test/val_credit.test.mjs test/val_isbn.test.mjs test/val_url.test.mjs test/val_phone.test.mjs test/val_postal.test.mjs test/val_semver.test.mjs test/val_jwt.test.mjs test/val_base64.test.mjs test/val_slug.test.mjs test/val_lat.test.mjs test/val_long.test.mjs test/val_btc.test.mjs test/val_eth.test.mjs test/val_date.test.mjs",
  grade: [
    {
      file: process.execPath,
      args: [
        "--test",
        "test/val_email.test.mjs",
        "test/val_uuid.test.mjs",
        "test/val_ipv4.test.mjs",
        "test/val_ipv6.test.mjs",
        "test/val_mac.test.mjs",
        "test/val_hex.test.mjs",
        "test/val_credit.test.mjs",
        "test/val_isbn.test.mjs",
        "test/val_url.test.mjs",
        "test/val_phone.test.mjs",
        "test/val_postal.test.mjs",
        "test/val_semver.test.mjs",
        "test/val_jwt.test.mjs",
        "test/val_base64.test.mjs",
        "test/val_slug.test.mjs",
        "test/val_lat.test.mjs",
        "test/val_long.test.mjs",
        "test/val_btc.test.mjs",
        "test/val_eth.test.mjs",
        "test/val_date.test.mjs",
      ],
      label: "all 20 test suites pass",
    },
  ],
} as BenchTask;

export const SCALE_GENERATED_TASKS: BenchTask[] = [
  ...SCALE_TASKS,
  scale6,
  scale12,
  scale20,
];
