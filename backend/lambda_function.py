"""
=============================================================================
EVENT REGISTRATION PORTAL — lambda_function.py
AWS Lambda Backend

Compatible with:
  - API Gateway HTTP API  (payload format 2.0)  ← your setup
  - API Gateway REST API  (payload format 1.0)

Environment variables (Lambda → Configuration → Environment variables):
  BUCKET_NAME     e.g.  event-registation-2026
  TABLE_NAME      e.g.  EventRegistrations
  SNS_TOPIC_ARN   e.g.  arn:aws:sns:us-east-1:031924002941:EventRegistrationNotification

IAM permissions required on the Lambda execution role:
  s3:PutObject, s3:DeleteObject  → arn:aws:s3:::BUCKET_NAME/*
  dynamodb:PutItem               → arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE_NAME
  sns:Publish                    → SNS_TOPIC_ARN
  + AWSLambdaBasicExecutionRole  (CloudWatch Logs)
=============================================================================
"""

import base64
import json
import logging
import os
import re
import string
import unicodedata
import uuid
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

# ---------------------------------------------------------------------------
#  Logging
# ---------------------------------------------------------------------------
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
#  Environment variables
#  Strip ALL whitespace and invisible Unicode characters that can be
#  accidentally pasted into the Lambda console (zero-width spaces,
#  non-breaking spaces, BOM characters, smart quotes, etc.)
#  These invisible chars cause DynamoDB ValidationException even though
#  the value looks correct on screen.
# ---------------------------------------------------------------------------
def _clean_env(key: str) -> str:
    """Read an env var and strip every non-printable / non-ASCII character."""
    raw = os.environ.get(key, "")
    # Remove any character that is not a printable ASCII character (32-126)
    # This catches zero-width spaces, BOM, non-breaking spaces, smart quotes, etc.
    cleaned = "".join(c for c in raw if 32 <= ord(c) <= 126).strip()
    if raw != cleaned:
        logger.warning(
            "ENV VAR '%s' contained invisible/invalid characters and was cleaned. "
            "Original repr: %r  Cleaned: %r",
            key, raw, cleaned,
        )
    return cleaned


BUCKET_NAME   = _clean_env("BUCKET_NAME")
TABLE_NAME    = _clean_env("TABLE_NAME")
SNS_TOPIC_ARN = _clean_env("SNS_TOPIC_ARN")
AWS_REGION    = os.environ.get("AWS_REGION", "us-east-1")  # injected by Lambda runtime

# Log startup values (safe — no credentials)
logger.info(
    "STARTUP — BUCKET_NAME=%r  TABLE_NAME=%r  REGION=%s",
    BUCKET_NAME, TABLE_NAME, AWS_REGION
)

# Detect missing vars at cold-start
_missing_vars = [
    name for name, val in {
        "BUCKET_NAME":   BUCKET_NAME,
        "TABLE_NAME":    TABLE_NAME,
        "SNS_TOPIC_ARN": SNS_TOPIC_ARN,
    }.items() if not val
]
if _missing_vars:
    logger.error(
        "STARTUP ERROR — missing env vars: %s "
        "→ Lambda Console → Configuration → Environment variables",
        ", ".join(_missing_vars),
    )

# ---------------------------------------------------------------------------
#  AWS clients
# ---------------------------------------------------------------------------
s3_client    = boto3.client("s3")
dynamodb_res = boto3.resource("dynamodb")
sns_client   = boto3.client("sns")

# ---------------------------------------------------------------------------
#  Constants
# ---------------------------------------------------------------------------
MAX_FILE_BYTES = 5 * 1024 * 1024

ALLOWED_MIME_TYPES = {
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
}

ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png"}

REQUIRED_FIELDS = [
    "name", "email", "phone", "department",
    "college", "event", "fileName", "fileType", "fileData",
]

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type":                 "application/json",
}


# =============================================================================
#  Lambda entry point
# =============================================================================
def lambda_handler(event, context):
    try:
        return _handle(event, context)
    except Exception:
        logger.exception("UNHANDLED EXCEPTION")
        return _build_response(500, {
            "success": False,
            "message": "An unexpected error occurred. Please try again.",
        })


# =============================================================================
#  Internal handler
# =============================================================================
def _handle(event, context):
    logger.info("=== New registration request ===")
    logger.info("Event keys: %s", list(event.keys()))

    # ------------------------------------------------------------------
    #  Guard: missing env vars
    # ------------------------------------------------------------------
    if _missing_vars:
        logger.error("Aborting — missing env vars: %s", _missing_vars)
        return _build_response(500, {
            "success": False,
            "message": "Backend configuration error. Missing: " + ", ".join(_missing_vars),
        })

    # ------------------------------------------------------------------
    #  CORS pre-flight
    #  API Gateway HTTP API (v2) uses:  event["requestContext"]["http"]["method"]
    #  API Gateway REST API (v1) uses:  event["httpMethod"]
    #  Both are handled here.
    # ------------------------------------------------------------------
    http_method = _get_http_method(event)
    logger.info("HTTP method: %s", http_method)

    if http_method == "OPTIONS":
        return _build_response(200, {"message": "CORS OK"})

    # ------------------------------------------------------------------
    #  Step 1 — Parse body
    #  API Gateway HTTP API (v2) may base64-encode the body when the
    #  content-type is not text. We decode it if isBase64Encoded=true.
    # ------------------------------------------------------------------
    try:
        body = _parse_body(event)
    except Exception as exc:
        logger.warning("Body parse error: %s", exc)
        return _build_response(400, {
            "success": False,
            "message": "Invalid request format. Body must be valid JSON.",
        })

    logger.info("Body parsed. Fields: %s", list(body.keys()))

    # ------------------------------------------------------------------
    #  Step 2 — Validate
    # ------------------------------------------------------------------
    err = _validate(body)
    if err:
        logger.warning("Validation failed: %s", err)
        return _build_response(400, {"success": False, "message": err})

    logger.info("Validation passed")

    # Extract clean values
    participant_name = body["name"].strip()
    email            = body["email"].strip().lower()
    phone            = body["phone"].strip()
    department       = body["department"].strip()
    college          = body["college"].strip()
    event_name       = body["event"].strip()
    file_name_raw    = body["fileName"].strip()
    file_type        = body["fileType"].strip()
    file_data_b64    = body["fileData"]

    # ------------------------------------------------------------------
    #  Step 3 — Registration ID (server-side only)
    # ------------------------------------------------------------------
    registration_id = "REG-2026-" + uuid.uuid4().hex[:6].upper()
    logger.info("Registration ID: %s", registration_id)

    # ------------------------------------------------------------------
    #  Step 4 — Decode Base64 file
    # ------------------------------------------------------------------
    try:
        clean_b64  = re.sub(r"\s+", "", file_data_b64)
        file_bytes = base64.b64decode(clean_b64, validate=True)
    except Exception as exc:
        logger.warning("Base64 decode failed: %s", exc)
        return _build_response(400, {
            "success": False,
            "message": "Could not decode the uploaded file. Please try again.",
        })

    decoded_size = len(file_bytes)
    logger.info("File decoded — %d bytes", decoded_size)

    if decoded_size > MAX_FILE_BYTES:
        return _build_response(400, {
            "success": False,
            "message": "File exceeds the 5 MB limit.",
        })

    # ------------------------------------------------------------------
    #  Step 5 — Upload to S3
    # ------------------------------------------------------------------
    safe_name = _sanitize_filename(file_name_raw)
    s3_key    = f"{department}/{registration_id}_{safe_name}"
    logger.info("S3 upload — bucket=%s  key=%s", BUCKET_NAME, s3_key)

    try:
        s3_client.put_object(
            Bucket=BUCKET_NAME,
            Key=s3_key,
            Body=file_bytes,
            ContentType=file_type,
        )
        logger.info("S3 upload successful")
    except ClientError as exc:
        code = exc.response["Error"]["Code"]
        msg  = exc.response["Error"]["Message"]
        logger.error(
            "S3 FAILED — Code=%s  Bucket=%s  Key=%s  Msg=%s",
            code, BUCKET_NAME, s3_key, msg
        )
        return _build_response(500, {
            "success": False,
            "message": f"S3 upload failed ({code}). Check s3:PutObject permission on bucket '{BUCKET_NAME}'.",
        })

    document_url = f"https://{BUCKET_NAME}.s3.{AWS_REGION}.amazonaws.com/{s3_key}"
    logger.info("Document URL: %s", document_url)

    # ------------------------------------------------------------------
    #  Step 6 — Save to DynamoDB
    #  Resolve the table INSIDE the handler so _clean_env() has already
    #  run and TABLE_NAME is guaranteed to be a clean ASCII string.
    # ------------------------------------------------------------------
    logger.info("DynamoDB save — table=%r", TABLE_NAME)
    db_table   = dynamodb_res.Table(TABLE_NAME)
    created_at = datetime.now(timezone.utc).isoformat()

    item = {
        "registration-id": registration_id,
        "name":           participant_name,
        "email":          email,
        "phone":          phone,
        "department":     department,
        "college":        college,
        "event":          event_name,
        "fileName":       safe_name,
        "s3Key":          s3_key,
        "documentUrl":    document_url,
        "status":         "SUBMITTED",
        "createdAt":      created_at,
    }

    try:
        db_table.put_item(Item=item)
        logger.info("DynamoDB save successful")
    except ClientError as exc:
        code = exc.response["Error"]["Code"]
        msg  = exc.response["Error"]["Message"]
        logger.error(
            "DynamoDB FAILED — Code=%s  Table=%r  Msg=%s",
            code, TABLE_NAME, msg
        )
        # Rollback S3 object
        try:
            s3_client.delete_object(Bucket=BUCKET_NAME, Key=s3_key)
            logger.info("S3 rollback successful")
        except ClientError as rb:
            logger.error(
                "S3 rollback FAILED — orphaned object: %s  Code=%s",
                s3_key, rb.response["Error"]["Code"]
            )
        return _build_response(500, {
            "success": False,
            "message": (
                f"DynamoDB save failed ({code}). "
                f"Table name used: '{TABLE_NAME}'. "
                "Check: table exists, TABLE_NAME env var is correct (no hidden characters), "
                "and IAM role has dynamodb:PutItem."
            ),
        })

    # ------------------------------------------------------------------
    #  Step 7 — SNS notification (non-fatal if it fails)
    # ------------------------------------------------------------------
    sns_msg = "\n".join([
        "New Event Registration",
        "=" * 40,
        "",
        f"Registration ID : {registration_id}",
        f"Participant     : {participant_name}",
        f"Email           : {email}",
        f"Phone           : {phone}",
        f"Department      : {department}",
        f"College         : {college}",
        f"Event           : {event_name}",
        f"Document        : {s3_key}",
        f"Status          : Successfully submitted",
        "",
        "=" * 40,
        "Automated notification — Event Registration Portal",
    ])

    logger.info("SNS publish — topic=%s", SNS_TOPIC_ARN)
    try:
        sns_client.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject="New Event Registration",
            Message=sns_msg,
        )
        logger.info("SNS notification sent")
    except ClientError as exc:
        logger.error(
            "SNS FAILED (non-fatal) — Code=%s  Reg %s is intact.",
            exc.response["Error"]["Code"], registration_id,
        )

    # ------------------------------------------------------------------
    #  Step 8 — Return success
    # ------------------------------------------------------------------
    logger.info(
        "=== COMPLETE — ID=%s  %s  %s ===",
        registration_id, participant_name, event_name
    )
    return _build_response(200, {
        "success":        True,
        "message":        "Registration successful",
        "registration-id": registration_id,
        "documentUrl":    document_url,
    })


# =============================================================================
#  Helpers
# =============================================================================

def _get_http_method(event: dict) -> str:
    """Extract HTTP method — works for both API Gateway versions:
    REST API  (v1 / format 1.0): event["httpMethod"]
    HTTP API  (v2 / format 2.0): event["requestContext"]["http"]["method"]
    """
    # v1 REST API
    if "httpMethod" in event:
        return event["httpMethod"].upper()
    # v2 HTTP API
    try:
        return event["requestContext"]["http"]["method"].upper()
    except (KeyError, TypeError):
        return "POST"   # safe default


def _parse_body(event: dict) -> dict:
    """Parse the request body from an API Gateway event.

    Handles:
      A) API Gateway v1/v2 normal:  event["body"] is a JSON string
      B) API Gateway v2 binary:     event["isBase64Encoded"]=True  → decode first
      C) Lambda test console:       event["body"] is already a dict
      D) Direct invocation:         flat event with no "body" key
    """
    raw = event.get("body")

    # Case D — direct invocation with a flat payload
    if raw is None:
        if any(f in event for f in REQUIRED_FIELDS):
            logger.info("Direct invocation — using event as body")
            return event
        raise ValueError("event['body'] is missing")

    # Case C — already a dict (Lambda console test)
    if isinstance(raw, dict):
        logger.info("Body is already a dict")
        return raw

    # Case B — API Gateway v2 may base64-encode the body
    if event.get("isBase64Encoded", False) and isinstance(raw, str):
        logger.info("Body is base64-encoded — decoding")
        raw = base64.b64decode(raw).decode("utf-8")

    # Case A — normal JSON string
    return json.loads(raw)


def _validate(body: dict):
    """Returns None if valid, or an error string."""
    for field in REQUIRED_FIELDS:
        if not str(body.get(field, "")).strip():
            return f"'{field}' is required and cannot be empty."

    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", body["email"].strip()):
        return "Please provide a valid email address."

    if not re.fullmatch(r"[6-9]\d{9}", body["phone"].strip()):
        return "Please provide a valid 10-digit Indian mobile number."

    file_type = body["fileType"].strip()
    if file_type not in ALLOWED_MIME_TYPES:
        return f"Unsupported file type '{file_type}'. Allowed: PDF, JPEG, PNG."

    ext = os.path.splitext(body["fileName"].strip())[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return f"Unsupported extension '{ext}'. Allowed: .pdf .jpg .jpeg .png"

    file_data = body.get("fileData", "").strip()
    if not file_data:
        return "File data (fileData) is missing."

    if len(file_data) * 0.75 > MAX_FILE_BYTES * 1.02:
        return "File size exceeds the 5 MB limit."

    return None


def _sanitize_filename(filename: str) -> str:
    """Return a safe S3-key-safe filename:
    - basename only (blocks path traversal)
    - ASCII normalised
    - unsafe chars → underscore
    - max 100 chars
    """
    filename = os.path.basename(filename)
    filename = (
        unicodedata.normalize("NFKD", filename)
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    name, ext = os.path.splitext(filename)
    ext  = ext.lower()
    safe = string.ascii_letters + string.digits + "-"
    name = "".join(c if c in safe else "_" for c in name)
    name = re.sub(r"_+", "_", name).strip("_") or "document"
    return name[: max(1, 100 - len(ext))] + ext


def _build_response(status_code: int, body: dict) -> dict:
    """API Gateway proxy integration response with CORS headers."""
    return {
        "statusCode": status_code,
        "headers":    CORS_HEADERS,
        "body":       json.dumps(body),
    }
