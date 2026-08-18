# Event Registration Backend — Deployment & Testing Guide

## Project Structure

```
backend/
├── lambda_function.py          ← Lambda source code (deploy this)
├── iam_policy.json             ← Least-privilege IAM policy template
└── test_events/
    ├── test_valid_registration.json
    ├── test_missing_field.json
    ├── test_invalid_email.json
    ├── test_invalid_filetype.json
    └── test_cors_preflight.json
```

---

## Step 1 — AWS Resource Setup

### 1a. S3 Bucket

1. Go to **S3 → Create bucket**
2. Name: `event-registration-sujith-2026` (must be globally unique — change it)
3. Region: `ap-south-1` (Mumbai) or your preferred region
4. **Uncheck** "Block all public access" for the demo
5. After creation, go to **Permissions → Bucket policy** and paste:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadDocuments",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::event-registration-sujith-2026/*"
  }]
}
```

> **Note:** The Lambda only needs `s3:PutObject` and `s3:DeleteObject`.
> Public read is controlled by the **bucket policy**, not Lambda permissions.

---

### 1b. DynamoDB Table

1. Go to **DynamoDB → Create table**
2. Table name: `EventRegistrations`
3. Partition key: `registrationId` (String)
4. Sort key: (leave empty)
5. Billing mode: **On-demand** (pay per request — best for events)
6. Click **Create table**

---

### 1c. SNS Topic

1. Go to **SNS → Topics → Create topic**
2. Type: **Standard**
3. Name: `EventRegistrationNotification`
4. Click **Create topic**
5. Copy the **Topic ARN** — you'll need it as an environment variable

**Subscribe the organiser's email:**
1. Inside the topic → **Create subscription**
2. Protocol: **Email**
3. Endpoint: organiser's email address
4. Click **Create subscription**
5. Check the inbox and click the confirmation link

---

### 1d. Lambda Function

1. Go to **Lambda → Create function**
2. Choose: **Author from scratch**
3. Function name: `EventRegistrationBackend`
4. Runtime: **Python 3.12** (or the latest Python version available)
5. Architecture: `x86_64`
6. Click **Create function**

**Upload the code:**
- In the Lambda code editor, replace the default code with the contents of `lambda_function.py`
- Click **Deploy**

**Set environment variables:**
Go to **Configuration → Environment variables → Edit** and add:

| Key             | Value (your real values)                                    |
|-----------------|-------------------------------------------------------------|
| `BUCKET_NAME`   | `event-registration-sujith-2026`                            |
| `TABLE_NAME`    | `EventRegistrations`                                        |
| `SNS_TOPIC_ARN` | `arn:aws:sns:ap-south-1:123456789012:EventRegistrationNotification` |

**Increase timeout:**
Go to **Configuration → General configuration → Edit**
- Timeout: `30 seconds` (file uploads can take a moment)
- Memory: `256 MB`

---

### 1e. IAM — Lambda Execution Role

1. Go to **IAM → Roles → Find the role** that was auto-created for your Lambda
   (it will be named something like `EventRegistrationBackend-role-xxxx`)
2. Click **Add permissions → Create inline policy**
3. Switch to the **JSON** tab
4. Paste the contents of `iam_policy.json` — replacing:
   - `REGION` with your region (e.g., `ap-south-1`)
   - `ACCOUNT_ID` with your 12-digit AWS account ID
   - `BUCKET_NAME` with your real bucket name
5. Name the policy: `EventRegistrationPolicy`
6. Click **Create policy**

> Also attach the **AWSLambdaBasicExecutionRole** managed policy
> for CloudWatch Logs if it isn't already attached.

---

## Step 2 — API Gateway Setup

1. Go to **API Gateway → Create API → REST API → Build**
2. API name: `EventRegistrationAPI`
3. Endpoint type: **Regional**

**Create resource and method:**
1. Create resource: `/register`
2. On `/register`, create method: **POST**
3. Integration type: **Lambda Function**
4. Check **Use Lambda Proxy integration** ✓
5. Lambda function: `EventRegistrationBackend`
6. Click **Save**

**Enable CORS:**
1. Select the `/register` resource
2. Click **Actions → Enable CORS**
3. Access-Control-Allow-Origin: `'*'`  (or your S3 website URL)
4. Click **Enable CORS and replace existing CORS headers**

**Deploy:**
1. Click **Actions → Deploy API**
2. Deployment stage: **[New stage]** → name it `prod`
3. Click **Deploy**
4. Copy the **Invoke URL** — e.g.:
   `https://abc123xyz.execute-api.ap-south-1.amazonaws.com/prod`

**Your API endpoint:**
```
https://abc123xyz.execute-api.ap-south-1.amazonaws.com/prod/register
```

---

## Step 3 — Configure the Frontend

Open `frontend/script.js` and replace:

```js
const API_URL = "YOUR_API_GATEWAY_URL";
```

with:

```js
const API_URL = "https://abc123xyz.execute-api.ap-south-1.amazonaws.com/prod/register";
```

---

## Step 4 — Testing

### 4a. Generate a Real Base64 Test String

**Windows PowerShell:**
```powershell
$bytes = [System.IO.File]::ReadAllBytes("C:\path\to\test.pdf")
$b64   = [Convert]::ToBase64String($bytes)
$b64 | Set-Clipboard   # copies to clipboard
```

**Linux / macOS / Git Bash:**
```bash
base64 -w 0 test.pdf | pbcopy   # macOS
base64 -w 0 test.pdf | xclip    # Linux
```

Paste the Base64 string into the `"fileData"` field of the test event JSON,
replacing `"BASE64_DATA"`.

---

### 4b. Test Lambda Directly (Lambda Console)

1. Open your Lambda function
2. Click **Test → Create new test event**
3. Paste the contents of `test_events/test_valid_registration.json`
4. Replace `BASE64_DATA` with your real Base64 string
5. Click **Test**
6. Expected result:
```json
{
  "statusCode": 200,
  "body": "{\"success\": true, \"registrationId\": \"REG-2026-XXXXXX\", ...}"
}
```

Run the other test events to verify error handling:
- `test_missing_field.json` → should return `400`
- `test_invalid_email.json` → should return `400`
- `test_invalid_filetype.json` → should return `400`
- `test_cors_preflight.json` → should return `200`

---

### 4c. Test API Gateway (curl / Postman)

**curl (PowerShell — Windows):**
```powershell
$body = @{
  name       = "Vignesh Kumar"
  email      = "vignesh@gmail.com"
  phone      = "9876543210"
  department = "CSE"
  college    = "Karpagam Institute of Technology"
  event      = "Technical Workshop"
  fileName   = "test.pdf"
  fileType   = "application/pdf"
  fileData   = (Get-Content "base64.txt" -Raw)
} | ConvertTo-Json

Invoke-RestMethod `
  -Method POST `
  -Uri "https://YOUR_API_ID.execute-api.ap-south-1.amazonaws.com/prod/register" `
  -ContentType "application/json" `
  -Body $body
```

**Postman:**
- Method: `POST`
- URL: your API Gateway invoke URL + `/register`
- Body: `raw` → `JSON`
- Paste the JSON payload with a real Base64 fileData value

---

### 4d. Verify S3 Upload

1. Go to **S3 → your bucket**
2. Look for a folder named after the department (e.g., `CSE/`)
3. Inside, find the uploaded file: `CSE/REG-2026-XXXXXX_test.pdf`
4. Click the file → **Object URL** → should be publicly viewable

---

### 4e. Verify DynamoDB Record

1. Go to **DynamoDB → Tables → EventRegistrations**
2. Click **Explore table items**
3. Find the item with your `registrationId`
4. Verify all fields: name, email, s3Key, documentUrl, createdAt, etc.

---

### 4f. Verify SNS Email Notification

1. Check the organiser's email inbox
2. Confirm you received the "New Event Registration" email
3. If not received:
   - Check the SNS topic → Subscriptions → confirm status is `Confirmed`
   - Check CloudWatch logs for SNS errors

---

### 4g. Verify CloudWatch Logs

1. Go to **CloudWatch → Log groups**
2. Find: `/aws/lambda/EventRegistrationBackend`
3. Click the latest log stream
4. You should see entries like:
   ```
   [INFO] Registration request received
   [INFO] Generated registration ID: REG-2026-A7F29B
   [INFO] Uploading document to S3: s3://event-registration-sujith-2026/CSE/...
   [INFO] Document uploaded to S3 successfully
   [INFO] Saving registration to DynamoDB — table: EventRegistrations
   [INFO] Registration saved to DynamoDB successfully
   [INFO] Publishing SNS notification
   [INFO] SNS notification sent successfully
   [INFO] Registration completed — ID: REG-2026-A7F29B
   ```

---

### 4h. Full Frontend-to-Backend Flow Test

1. Run the frontend locally:
   ```bash
   cd frontend
   python -m http.server 8080
   ```
2. Open `http://localhost:8080` in a browser
3. Fill in the registration form completely
4. Upload a valid PDF or image (under 5 MB)
5. Click **Submit Registration**
6. Verify:
   - ✅ Success card appears with a `REG-2026-XXXXXX` ID
   - ✅ "View Uploaded Document" link opens the file from S3
   - ✅ DynamoDB has the new record
   - ✅ Organiser received the SNS email
   - ✅ CloudWatch has the full log trail

---

## Architecture Summary

```
Participant (Browser)
        │
        │  POST /register  (JSON + Base64 file)
        ▼
  API Gateway  (REST, regional, proxy integration)
        │
        ▼
  Lambda: EventRegistrationBackend  (Python 3.12)
        │
        ├──▶  S3: event-registration-sujith-2026
        │         └── CSE/REG-2026-A7F29B_filename.pdf
        │
        ├──▶  DynamoDB: EventRegistrations
        │         └── { registrationId, name, email, ... }
        │
        └──▶  SNS: EventRegistrationNotification
                  └── Email → Organiser inbox

  IAM Role  ──▶  Lambda (s3:PutObject, dynamodb:PutItem, sns:Publish, logs:*)
  CloudWatch ──▶  /aws/lambda/EventRegistrationBackend
```
