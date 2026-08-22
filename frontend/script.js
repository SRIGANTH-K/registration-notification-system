/**
 * ============================================================
 *  EVENT REGISTRATION PORTAL — script.js
 *  Communicates with: AWS API Gateway → Lambda → DynamoDB + S3 + SNS
 *
 *  No AWS credentials are stored here.
 *  The frontend only calls the API Gateway endpoint below.
 * ============================================================
 */

/**
 * ⚠️  CONFIGURE THIS BEFORE DEPLOYING
 *  Replace the value below with your real API Gateway Invoke URL.
 *  Format: "https://<id>.execute-api.<region>.amazonaws.com/<stage>/register"
 *
 *  Where to find it:
 *  AWS Console → API Gateway → Your API → Stages → <stage> → Invoke URL
 *  Then append  /register  (the resource path you created).
 */
const API_URL = "https://bksxuggez1.execute-api.us-east-1.amazonaws.com/prod/register";

// ============================================================
//  Allowed file types (used in both JS validation and display)
// ============================================================
const ALLOWED_EXT    = [".pdf", ".jpg", ".jpeg", ".png"];
const ALLOWED_MIME   = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];
const MAX_SIZE_MB    = 5;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

// ============================================================
//  DOM References
// ============================================================
const form            = document.getElementById("registrationForm");
const submitBtn       = document.getElementById("submitBtn");
const submitBtnText   = document.getElementById("submitBtnText");
const submitSpinner   = document.getElementById("submitSpinner");

const formCard        = document.getElementById("formCard");
const successCard     = document.getElementById("successCard");
const errorCard       = document.getElementById("errorCard");

const regIdDisplay    = document.getElementById("regIdDisplay");
const docUrlLink      = document.getElementById("docUrlLink");
const errorDetail     = document.getElementById("errorDetail");

const resetBtn        = document.getElementById("resetBtn");
const retryBtn        = document.getElementById("retryBtn");

const fileInput       = document.getElementById("document");
const fileUploadArea  = document.getElementById("fileUploadArea");
const filePreview     = document.getElementById("filePreview");
const filePlaceholder = document.getElementById("fileUploadPlaceholder");
const filePreviewName = document.getElementById("filePreviewName");
const filePreviewSize = document.getElementById("filePreviewSize");
const fileRemoveBtn   = document.getElementById("fileRemoveBtn");

const progressSteps   = document.getElementById("progressSteps");
const progressConns   = document.querySelectorAll(".progress-connector");

const navToggle       = document.querySelector(".nav-toggle");
const nav             = document.querySelector(".nav");

// ============================================================
//  Mobile Navigation
// ============================================================
if (navToggle && nav) {
  navToggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  nav.querySelectorAll(".nav-link").forEach(link => {
    link.addEventListener("click", () => {
      nav.classList.remove("is-open");
      navToggle.setAttribute("aria-expanded", "false");
    });
  });
}

// ============================================================
//  Utility: format file size for display
// ============================================================
function formatBytes(bytes) {
  if (bytes < 1024)            return bytes + " B";
  if (bytes < 1024 * 1024)     return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

// ============================================================
//  File Upload — preview, remove, drag-and-drop
// ============================================================

/**
 * Render the file preview panel for the given File object.
 * @param {File} file
 */
function showFilePreview(file) {
  filePreviewName.textContent = file.name;
  filePreviewSize.textContent = "Size: " + formatBytes(file.size);
  filePlaceholder.hidden = true;
  filePreview.hidden     = false;
  clearFieldError("document");
  fileUploadArea.classList.remove("is-error");
}

/** Reset the file input and hide the preview panel. */
function clearFilePreview() {
  filePreview.hidden     = true;
  filePlaceholder.hidden = false;
  fileInput.value        = "";
}

// Trigger preview when user picks a file via the file picker
fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    showFilePreview(fileInput.files[0]);
  }
});

// Remove selected file
fileRemoveBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  clearFilePreview();
});

// Drag-and-drop
fileUploadArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  fileUploadArea.classList.add("drag-over");
});
fileUploadArea.addEventListener("dragleave", () => {
  fileUploadArea.classList.remove("drag-over");
});
fileUploadArea.addEventListener("drop", (e) => {
  e.preventDefault();
  fileUploadArea.classList.remove("drag-over");
  const { files } = e.dataTransfer;
  if (files && files.length > 0) {
    try {
      fileInput.files = files;   // works in Chrome/Edge/Firefox
    } catch (_) {
      // browsers that don't support FileList assignment — preview only
    }
    showFilePreview(files[0]);
  }
});

// Keyboard accessibility: press Enter or Space to open the file picker
fileUploadArea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

// ============================================================
//  Validation helpers
// ============================================================

/**
 * Mark a field as invalid and display an error message beside it.
 * @param {string} fieldId  — ID of the input element
 * @param {string} message  — error text to show
 */
function showFieldError(fieldId, message) {
  const errorEl = document.getElementById(fieldId + "Error");
  const inputEl = document.getElementById(fieldId);
  if (errorEl) errorEl.textContent = message;
  if (inputEl) {
    inputEl.classList.add("is-error");
    inputEl.classList.remove("is-valid");
  }
}

/**
 * Clear the error state for a field.
 * @param {string} fieldId
 */
function clearFieldError(fieldId) {
  const errorEl = document.getElementById(fieldId + "Error");
  const inputEl = document.getElementById(fieldId);
  if (errorEl) errorEl.textContent = "";
  if (inputEl) inputEl.classList.remove("is-error");
}

/**
 * Mark a field as successfully validated.
 * @param {string} fieldId
 */
function markFieldValid(fieldId) {
  clearFieldError(fieldId);
  const inputEl = document.getElementById(fieldId);
  if (inputEl) inputEl.classList.add("is-valid");
}

// Clear field errors as the user types / changes values
["name", "email", "phone", "department", "college", "event"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", () => clearFieldError(id));
});

/**
 * Run all form validations.
 * @returns {boolean} true if the form is valid and ready to submit
 */
function validateForm() {
  let isValid = true;

  // Full name
  const name = document.getElementById("name").value.trim();
  if (!name) {
    showFieldError("name", "Full name is required.");
    isValid = false;
  } else {
    markFieldValid("name");
  }

  // Email
  const email = document.getElementById("email").value.trim();
  if (!email) {
    showFieldError("email", "Email address is required.");
    isValid = false;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showFieldError("email", "Please enter a valid email address.");
    isValid = false;
  } else {
    markFieldValid("email");
  }

  // Phone — Indian 10-digit mobile starting with 6–9
  const phone = document.getElementById("phone").value.trim();
  if (!phone) {
    showFieldError("phone", "Phone number is required.");
    isValid = false;
  } else if (!/^[6-9]\d{9}$/.test(phone)) {
    showFieldError("phone", "Enter a valid 10-digit Indian mobile number.");
    isValid = false;
  } else {
    markFieldValid("phone");
  }

  // Department
  const department = document.getElementById("department").value;
  if (!department) {
    showFieldError("department", "Please select your department.");
    isValid = false;
  } else {
    markFieldValid("department");
  }

  // College
  const college = document.getElementById("college").value.trim();
  if (!college) {
    showFieldError("college", "College name is required.");
    isValid = false;
  } else {
    markFieldValid("college");
  }

  // Event
  const selectedEvent = document.getElementById("event").value;
  if (!selectedEvent) {
    showFieldError("event", "Please select an event.");
    isValid = false;
  } else {
    markFieldValid("event");
  }

  // Document file
  const file = fileInput.files[0];
  if (!file) {
    showFieldError("document", "Please upload the required document.");
    fileUploadArea.classList.add("is-error");
    isValid = false;
  } else {
    const ext = "." + file.name.split(".").pop().toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      showFieldError("document", "Unsupported file type. Use PDF, JPG, JPEG, or PNG.");
      fileUploadArea.classList.add("is-error");
      isValid = false;
    } else if (file.size > MAX_SIZE_BYTES) {
      showFieldError("document", `File exceeds ${MAX_SIZE_MB} MB limit.`);
      fileUploadArea.classList.add("is-error");
      isValid = false;
    } else {
      clearFieldError("document");
      fileUploadArea.classList.remove("is-error");
    }
  }

  return isValid;
}

// ============================================================
//  Progress indicator
// ============================================================
const STEPS = ["preparing", "submitting", "completed"];

/**
 * Highlight the current submission step.
 * @param {"preparing"|"submitting"|"completed"} stepName
 */
function setProgressStep(stepName) {
  progressSteps.hidden = false;
  const activeIdx = STEPS.indexOf(stepName);

  STEPS.forEach((s, i) => {
    const el = document.getElementById("step-" + s);
    if (!el) return;
    el.classList.remove("active", "done");
    if (i < activeIdx) el.classList.add("done");
    if (i === activeIdx) el.classList.add("active");
  });

  progressConns.forEach((conn, i) => {
    conn.classList.toggle("done", i < activeIdx);
  });
}

/** Reset all progress steps to the default (inactive) state. */
function hideProgressSteps() {
  progressSteps.hidden = true;
  STEPS.forEach(s => {
    const el = document.getElementById("step-" + s);
    if (el) el.classList.remove("active", "done");
  });
  progressConns.forEach(c => c.classList.remove("done"));
}

// ============================================================
//  Submit button loading state
// ============================================================
function setLoading(loading) {
  submitBtn.disabled          = loading;
  submitBtnText.textContent   = loading ? "Submitting..." : "Submit Registration";
  submitSpinner.hidden        = !loading;
}

// ============================================================
//  File → Base64
// ============================================================
/**
 * Read a File and return its contents as a Base64 string
 * (the data URI prefix is stripped — only the raw Base64 is returned).
 * @param {File} file
 * @returns {Promise<string>}
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Failed to read the file."));
    reader.readAsDataURL(file);
  });
}

// ============================================================
//  UI: show / hide cards
// ============================================================

/**
 * Show the success card after a successful API response.
 * @param {string} registrationId
 * @param {string|null} documentUrl
 */
function showSuccessCard(registrationId, documentUrl) {
  formCard.hidden    = true;
  errorCard.hidden   = true;
  successCard.hidden = false;

  regIdDisplay.textContent = registrationId;

  if (documentUrl) {
    docUrlLink.href   = documentUrl;
    docUrlLink.hidden = false;
  } else {
    docUrlLink.hidden = true;
  }

  successCard.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Show the error card with a specific message.
 * @param {string} message
 */
function showErrorCard(message) {
  formCard.hidden    = true;
  successCard.hidden = true;
  errorCard.hidden   = false;

  const msg = (message || "").trim();
  if (msg) {
    errorDetail.textContent = msg;
    errorDetail.hidden      = false;
  } else {
    errorDetail.textContent = "";
    errorDetail.hidden      = true;
  }

  errorCard.scrollIntoView({ behavior: "smooth", block: "center" });
}

/** Clear the form and return to the registration card. */
function resetToForm() {
  successCard.hidden = true;
  errorCard.hidden   = true;
  formCard.hidden    = false;

  form.reset();
  clearFilePreview();   // resets file input and hides preview panel
  hideProgressSteps();

  // Clear all field validation states
  ["name", "email", "phone", "department", "college", "event"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("is-valid", "is-error");
    clearFieldError(id);
  });
  clearFieldError("document");
  fileUploadArea.classList.remove("is-error");

  formCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Button event listeners
resetBtn.addEventListener("click", resetToForm);

retryBtn.addEventListener("click", () => {
  errorCard.hidden = true;
  formCard.hidden  = false;
  formCard.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ============================================================
//  Form submission
// ============================================================
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Guard: API URL must be configured
  if (!API_URL || API_URL.includes("YOUR_API_GATEWAY_URL")) {
    alert(
      "⚠️  API Gateway URL is not configured.\n\n" +
      "Open script.js and replace the placeholder with your real endpoint."
    );
    return;
  }

  // Run client-side validation
  if (!validateForm()) {
    // Scroll to the first invalid field
    const firstInvalid = form.querySelector(".is-error");
    if (firstInvalid) {
      firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
      firstInvalid.focus({ preventScroll: true });
    }
    return;
  }

  // ---- Step 1: Preparing (read file) ----
  setLoading(true);
  setProgressStep("preparing");

  let base64Data;
  try {
    base64Data = await fileToBase64(fileInput.files[0]);
  } catch (err) {
    setLoading(false);
    hideProgressSteps();
    showErrorCard("Could not read the selected file. Please try again.");
    return;
  }

  // Build the JSON payload sent to Lambda via API Gateway
  const selectedFile = fileInput.files[0];
  const payload = {
    name:       document.getElementById("name").value.trim(),
    email:      document.getElementById("email").value.trim(),
    phone:      document.getElementById("phone").value.trim(),
    department: document.getElementById("department").value,
    college:    document.getElementById("college").value.trim(),
    event:      document.getElementById("event").value,
    fileName:   selectedFile.name,
    fileType:   selectedFile.type || "application/octet-stream",
    fileData:   base64Data,
  };

  // ---- Step 2: Submitting (API call) ----
  setProgressStep("submitting");

  try {
    /**
     * POST to API Gateway.
     * API Gateway proxies the request to Lambda.
     * Lambda writes to DynamoDB, uploads to S3, and publishes to SNS.
     */
    const response = await fetch(API_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });

    // Always attempt to parse the JSON body regardless of HTTP status
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      // Body is not JSON (unexpected gateway error)
    }

    // ---- Success path ----
    // Lambda returns "registration-id" (hyphenated) not "registrationId"
    const regId = data && (data["registration-id"] || data.registrationId);
    if ((response.status === 200 || response.status === 201) &&
        data && data.success === true && regId) {
      setProgressStep("completed");
      // Brief pause so the user sees the "Completed" step
      setTimeout(() => {
        setLoading(false);
        showSuccessCard(regId, data.documentUrl || null);
      }, 700);
      return;
    }

    // ---- Error path ----
    setLoading(false);
    hideProgressSteps();
    showErrorCard(resolveErrorMessage(response.status, data));

  } catch (networkErr) {
    // Fetch threw — typically no internet or CORS preflight blocked
    setLoading(false);
    hideProgressSteps();
    showErrorCard(
      "Network error: unable to reach the server. " +
      "Check your internet connection and try again."
    );
  }
});

// ============================================================
//  Error message resolver
//  Shows the backend message when it's safe and useful.
//  Falls back to a generic message for unexpected status codes.
// ============================================================

/**
 * Decide what error text to display to the user.
 *
 * The Lambda now returns specific, safe error messages that describe the
 * AWS problem (e.g., wrong bucket name, missing IAM permission) without
 * exposing credentials or internal stack traces.  We show those messages
 * directly so the developer can diagnose without opening CloudWatch.
 *
 * We still block any string that looks like it contains raw AWS credentials.
 *
 * @param {number}      status  HTTP status code
 * @param {object|null} data    Parsed JSON response body (may be null)
 * @returns {string}
 */
function resolveErrorMessage(status, data) {
  // Use the backend's message if it is present and doesn't contain credentials
  if (data && data.message && !containsCredentials(data.message)) {
    return data.message;
  }

  // Generic fallbacks keyed by status code
  switch (status) {
    case 400: return "Invalid request. Please review your details and try again.";
    case 403: return "Access denied. Please contact the event coordinator.";
    case 404: return "Registration endpoint not found. Check the API Gateway URL.";
    case 409: return "A registration with this email already exists.";
    case 413: return "The uploaded file is too large. Please use a file under 5 MB.";
    case 422: return "Submitted data could not be processed. Please review the form.";
    case 429: return "Too many requests. Please wait a moment and try again.";
    case 500: return "Server error. Please try again in a few minutes.";
    case 502:
    case 503: return "Service temporarily unavailable. Please try again shortly.";
    default:  return "An unexpected error occurred. Please try again.";
  }
}

/**
 * Returns true if the message appears to contain AWS credentials or
 * internal IAM details that should never be shown to participants.
 * @param {string} msg
 * @returns {boolean}
 */
function containsCredentials(msg) {
  const blocked = [
    "AKIA",                 // AWS access key prefix
    "aws_secret",
    "aws_access_key",
    "SessionToken",
    "AssumeRole",
    "sts.amazonaws",
    "iam.amazonaws",
  ];
  const lower = msg.toLowerCase();
  return blocked.some(kw => lower.includes(kw.toLowerCase()));
}
