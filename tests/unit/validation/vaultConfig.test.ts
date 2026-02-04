import { describe, it, expect } from "vitest";
import {
  extractClusterId,
  validateVaultConfig,
  looksLikePlaceholder,
} from "../../../src/lib/validation/vaultConfig";

describe("Vault Configuration Validation", () => {
  describe("extractClusterId()", () => {
    it("should extract cluster ID from valid vault URLs with https://", () => {
      expect(extractClusterId("https://abc123.vault.skyflowapis.com")).toBe(
        "abc123"
      );
      expect(extractClusterId("https://test-cluster.vault.skyflowapis.com")).toBe(
        "test-cluster"
      );
      expect(extractClusterId("https://prod-123.vault.example.com")).toBe(
        "prod-123"
      );
    });

    it("should extract cluster ID from valid vault URLs without protocol", () => {
      expect(extractClusterId("abc123.vault.skyflowapis.com")).toBe(
        "abc123"
      );
      expect(extractClusterId("test-cluster.vault.skyflowapis.com")).toBe(
        "test-cluster"
      );
      expect(extractClusterId("prod-123.vault.example.com")).toBe(
        "prod-123"
      );
    });

    it("should extract cluster ID from http:// URLs (legacy support)", () => {
      expect(extractClusterId("http://abc123.vault.skyflowapis.com")).toBe(
        "abc123"
      );
    });

    it("should return null for invalid vault URLs", () => {
      expect(extractClusterId("https://example.com")).toBeNull();
      expect(extractClusterId("example.com")).toBeNull();
      expect(extractClusterId("not-a-url")).toBeNull();
      expect(extractClusterId("")).toBeNull();
    });

    it("should handle URLs with additional paths", () => {
      expect(
        extractClusterId("https://abc123.vault.skyflowapis.com/path/to/resource")
      ).toBe("abc123");
      expect(
        extractClusterId("abc123.vault.skyflowapis.com/path/to/resource")
      ).toBe("abc123");
    });
  });

  describe("validateVaultConfig()", () => {
    describe("successful validation", () => {
      it("should return valid result with complete config", () => {
        const result = validateVaultConfig({
          vaultId: "vault123",
          vaultUrl: "https://abc123.vault.skyflowapis.com",
          accountId: "acc456",
          workspaceId: "ws789",
        });

        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.config).toEqual({
          vaultId: "vault123",
          vaultUrl: "https://abc123.vault.skyflowapis.com",
          clusterId: "abc123",
          accountId: "acc456",
          workspaceId: "ws789",
        });
      });

      it("should return valid result with only required fields", () => {
        const result = validateVaultConfig({
          vaultId: "vault123",
          vaultUrl: "https://abc123.vault.skyflowapis.com",
        });

        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.config).toEqual({
          vaultId: "vault123",
          vaultUrl: "https://abc123.vault.skyflowapis.com",
          clusterId: "abc123",
          accountId: undefined,
          workspaceId: undefined,
        });
      });

      it("should accept vaultUrl without https:// protocol", () => {
        const result = validateVaultConfig({
          vaultId: "vault123",
          vaultUrl: "abc123.vault.skyflowapis.com",
        });

        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.config).toEqual({
          vaultId: "vault123",
          vaultUrl: "abc123.vault.skyflowapis.com",
          clusterId: "abc123",
          accountId: undefined,
          workspaceId: undefined,
        });
      });
    });

    describe("missing vaultId", () => {
      it("should return error when vaultId is missing", () => {
        const result = validateVaultConfig({
          vaultUrl: "https://abc123.vault.skyflowapis.com",
        });

        expect(result.isValid).toBe(false);
        expect(result.error).toBe(
          "vaultId is required (provide as query parameter or VAULT_ID environment variable)"
        );
        expect(result.config).toBeUndefined();
      });

      it("should return error when vaultId is empty string", () => {
        const result = validateVaultConfig({
          vaultId: "",
          vaultUrl: "https://abc123.vault.skyflowapis.com",
        });

        expect(result.isValid).toBe(false);
        expect(result.error).toContain("vaultId is required");
      });
    });

    describe("missing vaultUrl", () => {
      it("should return error when vaultUrl is missing", () => {
        const result = validateVaultConfig({
          vaultId: "vault123",
        });

        expect(result.isValid).toBe(false);
        expect(result.error).toBe(
          "vaultUrl is required (provide as query parameter or VAULT_URL environment variable)"
        );
        expect(result.config).toBeUndefined();
      });

      it("should return error when vaultUrl is empty string", () => {
        const result = validateVaultConfig({
          vaultId: "vault123",
          vaultUrl: "",
        });

        expect(result.isValid).toBe(false);
        expect(result.error).toContain("vaultUrl is required");
      });
    });

    describe("invalid vaultUrl format", () => {
      it("should return error for invalid vault URL format", () => {
        const result = validateVaultConfig({
          vaultId: "vault123",
          vaultUrl: "https://invalid.com",
        });

        expect(result.isValid).toBe(false);
        expect(result.error).toBe(
          "Invalid vaultUrl format. Expected format: https://<clusterId>.vault.skyflowapis.com or <clusterId>.vault.skyflowapis.com"
        );
        expect(result.config).toBeUndefined();
      });

      it("should return error for invalid URLs without protocol", () => {
        const result = validateVaultConfig({
          vaultId: "vault123",
          vaultUrl: "invalid.com",
        });

        expect(result.isValid).toBe(false);
        expect(result.error).toContain("Invalid vaultUrl format");
      });

      it("should return error for malformed URLs", () => {
        const result = validateVaultConfig({
          vaultId: "vault123",
          vaultUrl: "not-a-url",
        });

        expect(result.isValid).toBe(false);
        expect(result.error).toContain("Invalid vaultUrl format");
      });
    });

    describe("edge cases", () => {
      it("should handle all undefined parameters", () => {
        const result = validateVaultConfig({});

        expect(result.isValid).toBe(false);
        expect(result.error).toContain("vaultId is required");
      });

      it("should preserve optional fields when provided", () => {
        const result = validateVaultConfig({
          vaultId: "vault123",
          vaultUrl: "https://abc123.vault.skyflowapis.com",
          accountId: "account",
          workspaceId: "workspace",
        });

        expect(result.isValid).toBe(true);
        expect(result.config?.accountId).toBe("account");
        expect(result.config?.workspaceId).toBe("workspace");
      });
    });
  });

  describe("looksLikePlaceholder()", () => {
    describe("shell-style placeholders ${VAR_NAME}", () => {
      it("should detect ${SKYFLOW_VAULT_ID} as placeholder", () => {
        expect(looksLikePlaceholder("${SKYFLOW_VAULT_ID}")).toBe(true);
      });

      it("should detect ${SKYFLOW_VAULT_URL} as placeholder", () => {
        expect(looksLikePlaceholder("${SKYFLOW_VAULT_URL}")).toBe(true);
      });

      it("should detect ${VAULT_ID} as placeholder", () => {
        expect(looksLikePlaceholder("${VAULT_ID}")).toBe(true);
      });

      it("should detect ${MY_VAR_123} as placeholder", () => {
        expect(looksLikePlaceholder("${MY_VAR_123}")).toBe(true);
      });

      it("should detect lowercase ${my_var} as placeholder", () => {
        expect(looksLikePlaceholder("${my_var}")).toBe(true);
      });
    });

    describe("direct env var style $VAR_NAME", () => {
      it("should detect $SKYFLOW_VAULT_ID as placeholder", () => {
        expect(looksLikePlaceholder("$SKYFLOW_VAULT_ID")).toBe(true);
      });

      it("should detect $VAULT_URL as placeholder", () => {
        expect(looksLikePlaceholder("$VAULT_URL")).toBe(true);
      });
    });

    describe("mustache/handlebars style {{VAR_NAME}}", () => {
      it("should detect {{VAULT_ID}} as placeholder", () => {
        expect(looksLikePlaceholder("{{VAULT_ID}}")).toBe(true);
      });

      it("should detect {{vault_url}} as placeholder", () => {
        expect(looksLikePlaceholder("{{vault_url}}")).toBe(true);
      });
    });

    describe("Windows-style %VAR_NAME%", () => {
      it("should detect %VAULT_ID% as placeholder", () => {
        expect(looksLikePlaceholder("%VAULT_ID%")).toBe(true);
      });

      it("should detect %SKYFLOW_VAULT_URL% as placeholder", () => {
        expect(looksLikePlaceholder("%SKYFLOW_VAULT_URL%")).toBe(true);
      });
    });

    describe("valid values (not placeholders)", () => {
      it("should return false for actual vault IDs", () => {
        expect(looksLikePlaceholder("abc123def456")).toBe(false);
      });

      it("should return false for actual vault URLs", () => {
        expect(looksLikePlaceholder("https://abc123.vault.skyflowapis.com")).toBe(false);
      });

      it("should return false for URLs without protocol", () => {
        expect(looksLikePlaceholder("abc123.vault.skyflowapis.com")).toBe(false);
      });

      it("should return false for UUIDs", () => {
        expect(looksLikePlaceholder("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(false);
      });

      it("should return false for regular strings", () => {
        expect(looksLikePlaceholder("my-vault-id")).toBe(false);
      });

      it("should return false for strings containing $ but not as placeholder", () => {
        expect(looksLikePlaceholder("price$100")).toBe(false);
      });
    });

    describe("edge cases", () => {
      it("should return false for undefined", () => {
        expect(looksLikePlaceholder(undefined)).toBe(false);
      });

      it("should return false for empty string", () => {
        expect(looksLikePlaceholder("")).toBe(false);
      });

      it("should return false for partial placeholder patterns", () => {
        expect(looksLikePlaceholder("${")).toBe(false);
        expect(looksLikePlaceholder("${}")).toBe(false);
        expect(looksLikePlaceholder("{{}}")).toBe(false);
        expect(looksLikePlaceholder("%%")).toBe(false);
      });

      it("should return false for placeholder embedded in text", () => {
        expect(looksLikePlaceholder("prefix${VAR}suffix")).toBe(false);
        expect(looksLikePlaceholder("https://${CLUSTER}.vault.skyflowapis.com")).toBe(false);
      });
    });
  });
});
