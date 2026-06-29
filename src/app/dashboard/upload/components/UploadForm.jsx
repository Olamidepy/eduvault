"use client";

import { useState, useEffect } from "react";
import { FaCloudUploadAlt } from "react-icons/fa";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { abi } from "../../../../../contracts/EduVaultAbi.js";
import { celoSepolia } from "wagmi/chains";
import { parseAbiItem } from "viem";

const contractAddress = "0x3f48520ca0d8d51345b416b5a3e083dac8790f55";

// Transfer event signature for parsing
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
);

export default function UploadForm() {
  const { address } = useAccount();
  const { writeContract, data: txHash, error: writeError, isPending } = useWriteContract();
  const {
    isLoading: isWaiting,
    isSuccess: isConfirmed,
    isError: isFailed,
    data: receipt,
  } = useWaitForTransactionReceipt({ hash: txHash });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [usageRights, setUsageRights] = useState("Standard License (download only)");
  const [visibility, setVisibility] = useState("public");

  const [docFile, setDocFile] = useState(null);
  const [docFileName, setDocFileName] = useState(null);
  const [thumbFile, setThumbFile] = useState(null);
  const [thumbPreview, setThumbPreview] = useState(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [errorType, setErrorType] = useState(null); // 'upload' | 'wallet' | 'chain' | 'receipt'
  const [success, setSuccess] = useState(null);
  const [mintResult, setMintResult] = useState(null); // { tokenId, txHash, receipt }

  const handleDocChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setDocFile(file);
      setDocFileName(file.name);
    }
  };

  const handleThumbChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setThumbFile(file);
      setThumbPreview(URL.createObjectURL(file));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setErrorType(null);
    setSuccess(null);
    setMintResult(null);

    if (!title || !docFile) {
      setError("Title and document file are required.");
      setErrorType("validation");
      return;
    }

    if (!address) {
      setError("Please connect your wallet to mint an NFT.");
      setErrorType("wallet");
      return;
    }

    setSubmitting(true);

    try {
      // 1️⃣ Prepare FormData including all metadata
      const formData = new FormData();
      formData.append("file", docFile);
      if (thumbFile) formData.append("thumbnail", thumbFile);
      formData.append("name", title); //use the title for name
      formData.append("description", description);
      formData.append("price", price);
      formData.append("usageRights", usageRights);
      formData.append("visibility", visibility);
      formData.append("owner", address);

      // 2️⃣ Upload to backend with retry logic
      let uploadRes;
      let uploadData;
      let attempt = 0;
      const maxAttempts = 3;
      const initialDelay = 1000;

      while (true) {
        attempt++;
        try {
          uploadRes = await fetch("/api/upload", {
            method: "POST",
            body: formData,
          });
          uploadData = await uploadRes.json();
          console.log("Pinata Upload Response:", uploadData);
          
          if (uploadRes.ok && uploadData?.metadata) {
            break; // Success!
          }

          const errorMsg = uploadData?.error || `Upload failed with status ${uploadRes?.status}`;
          
          // Retry on rate limits (429) or server issues (5xx)
          const isRetriableStatus = [429, 500, 502, 503, 504].includes(uploadRes?.status);
          if (attempt >= maxAttempts || !isRetriableStatus) {
            throw new Error(errorMsg);
          }
        } catch (fetchErr) {
          if (attempt >= maxAttempts) {
            throw fetchErr;
          }
        }

        const backoffDelay = initialDelay * Math.pow(2, attempt - 1);
        console.warn(`Upload attempt ${attempt} failed. Retrying in ${backoffDelay}ms...`);
        setError(`Upload attempt ${attempt} failed. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        setError(null);
      }

      const tokenURI = uploadData.metadata;

      // 3️⃣ Mint NFT
      writeContract({
        address: contractAddress,
        abi,
        functionName: "mint",
        args: [tokenURI],
        chain: celoSepolia,
      });
    } catch (err) {
      console.error("Upload or Mint Error:", err);
      let friendlyError = err?.message || "Upload failed. Please try again.";
      if (friendlyError.includes("exceeds the 10MB limit")) {
        friendlyError = "The selected document exceeds the 10MB limit. Please choose a smaller file.";
      } else if (friendlyError.includes("exceeds the 5MB limit")) {
        friendlyError = "The selected thumbnail exceeds the 5MB limit. Please choose a smaller image.";
      } else if (friendlyError.includes("Unsupported file type") || friendlyError.includes("Unsupported file format")) {
        friendlyError = "The file type is not supported. Please upload a PDF, Word document, Excel sheet, PowerPoint presentation, text file, or ZIP archive.";
      } else if (friendlyError.includes("Unsupported thumbnail type")) {
        friendlyError = "The thumbnail image format is not supported. Please use JPG, PNG, or WEBP.";
      } else if (friendlyError.includes("fetch") || friendlyError.includes("Failed to fetch") || friendlyError.toLowerCase().includes("network")) {
        friendlyError = "Network error: Could not reach the upload server. Please check your internet connection.";
      } else if (friendlyError.toLowerCase().includes("too many requests") || friendlyError.toLowerCase().includes("rate limit") || friendlyError.includes("429")) {
        friendlyError = "Rate limit exceeded: You've made too many requests. Please wait a bit and try again.";
      }
      setError(friendlyError);
      setErrorType("upload");
      setSubmitting(false);
    }
  };

  // 4️⃣ React to writeContract errors (wallet/chain failures)
  useEffect(() => {
    if (writeError) {
      console.error("Write Contract Error:", writeError);
      
      // Distinguish between user rejection and other errors
      if (writeError.code === "ACTION_REJECTED" || writeError.message?.includes("User rejected")) {
        setError("Transaction rejected by user. Please try again.");
        setErrorType("wallet");
      } else if (writeError.message?.includes("insufficient funds")) {
        setError("Insufficient funds for gas. Please add CELO to your wallet.");
        setErrorType("wallet");
      } else {
        setError(writeError.message || "Transaction failed. Please try again.");
        setErrorType("chain");
      }
      
      setSubmitting(false);
    }
  }, [writeError]);

  // 5️⃣ Parse receipt and extract token ID on confirmation
  useEffect(() => {
    if (isConfirmed && receipt) {
      try {
        // Find the Transfer event from our contract
        const transferLog = receipt.logs.find(
          (log) =>
            log.address.toLowerCase() === contractAddress.toLowerCase() &&
            log.topics[0] === TRANSFER_EVENT.type
        );

        if (!transferLog) {
          throw new Error("Transfer event not found in transaction receipt");
        }

        // Parse the tokenId from the log (third indexed parameter = topics[3])
        const tokenId = BigInt(transferLog.topics[3]).toString();

        if (!tokenId || tokenId === "0") {
          throw new Error("Invalid token ID in receipt");
        }

        // Store complete mint result
        setMintResult({
          tokenId,
          txHash: receipt.transactionHash,
          receipt,
        });

        setSuccess(`🎉 Document uploaded successfully! Token ID: ${tokenId}`);
        console.log("Mint result:", { tokenId, txHash: receipt.transactionHash });
      } catch (err) {
        console.error("Receipt parsing error:", err);
        setError(`Mint completed but failed to parse receipt: ${err.message}`);
        setErrorType("receipt");
      } finally {
        setSubmitting(false);
      }
    } else if (isFailed) {
      setError("Transaction failed on-chain. Please try again.");
      setErrorType("chain");
      setSubmitting(false);
    }
  }, [isConfirmed, isFailed, receipt]);

  // Reset form on success
  const handleReset = () => {
    setTitle("");
    setDescription("");
    setPrice("");
    setUsageRights("Standard License (download only)");
    setVisibility("public");
    setDocFile(null);
    setDocFileName(null);
    setThumbFile(null);
    setThumbPreview(null);
    setSuccess(null);
    setError(null);
    setErrorType(null);
    setMintResult(null);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm"
    >
      <h2 className="text-xl font-bold mb-6">Create a New Study Resource</h2>
      <p className="text-sm text-gray-600 mb-8">
        Upload your lecture notes, projects, or past questions — and mint them as NFTs on-chain.
      </p>

      {/* Document Title */}
      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Document Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. ECO 304 - Development Economics Lecture Notes"
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          required
        />
      </div>

      {/* Short Description */}
      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Short Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Comprehensive lecture notes covering key development theories and examples."
          rows={3}
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
        />
      </div>

      {/* Thumbnail */}
      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Thumbnail Image</label>
        <div className="flex items-center gap-4">
          <input type="file" accept="image/*" onChange={handleThumbChange} className="text-sm" />
          {thumbPreview && (
            <img
              src={thumbPreview}
              alt="Thumbnail Preview"
              className="w-16 h-16 rounded object-cover border"
            />
          )}
        </div>
      </div>

      {/* Upload File */}
      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Upload Your File</label>
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-blue-400 transition">
          <input
            type="file"
            id="file-upload"
            className="hidden"
            onChange={handleDocChange}
            accept=".pdf,.doc,.docx,.ppt,.pptx,.zip"
          />
          <label
            htmlFor="file-upload"
            className="cursor-pointer flex flex-col items-center justify-center"
          >
            <FaCloudUploadAlt className="text-3xl text-blue-500 mb-2" />
            <p className="text-sm text-gray-600 mb-2">
              {docFileName ? (
                <span className="font-medium text-gray-800">{docFileName}</span>
              ) : (
                <>
                  Tap to Upload{" "}
                  <span className="text-gray-400">
                    (.pdf, .docx, .pptx, .zip | 10MB max)
                  </span>
                </>
              )}
            </p>
            <button
              type="button"
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Choose File
            </button>
          </label>
        </div>
      </div>

      {/* Price + Usage Rights */}
      <div className="grid sm:grid-cols-2 gap-4 mb-5">
        <div>
          <label className="block text-sm font-medium mb-2">Set Your Price (optional)</label>
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="celo"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Usage Rights</label>
          <select
            value={usageRights}
            onChange={(e) => setUsageRights(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          >
            <option>Standard License (download only)</option>
            <option>Creative Commons</option>
            <option>Private Use Only</option>
          </select>
        </div>
      </div>

      {/* Visibility */}
      <div className="mb-6">
        <label className="block text-sm font-medium mb-2">Visibility</label>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              id="public"
              name="visibility"
              checked={visibility === "public"}
              onChange={() => setVisibility("public")}
              className="accent-blue-600"
            />
            Public (default) — Anyone can view or download.
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              id="private"
              name="visibility"
              checked={visibility === "private"}
              onChange={() => setVisibility("private")}
              className="accent-blue-600"
            />
            Private — Only you and invited users can access.
          </label>
        </div>
      </div>

      {/* Feedback */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
          <p className="text-red-600 text-sm">{error}</p>
          {errorType && (
            <p className="text-red-500 text-xs mt-1">Error type: {errorType}</p>
          )}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-md">
          <p className="text-green-600 text-sm">{success}</p>
          {mintResult && (
            <div className="mt-2 text-xs text-green-700">
              <p>Transaction: {mintResult.txHash.slice(0, 10)}...{mintResult.txHash.slice(-8)}</p>
              <p>Token ID: {mintResult.tokenId}</p>
            </div>
          )}
        </div>
      )}

      {/* Buttons */}
      <div className="flex justify-end gap-4">
        {success && (
          <button
            type="button"
            onClick={handleReset}
            className="px-5 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition text-sm font-medium"
          >
            Upload Another
          </button>
        )}
        <button
          type="submit"
          disabled={submitting || isPending || isWaiting || success}
          className="px-5 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition text-sm font-medium disabled:opacity-60"
        >
          {submitting
            ? "Uploading..."
            : isPending || isWaiting
              ? "Minting NFT..."
              : "Submit & Mint NFT"}
        </button>
      </div>
    </form>
  );
}
