// frontend/lib/error-messages.ts
import axios from "axios";

type ErrorContext =
  | "auth-login"
  | "auth-register"
  | "project-create"
  | "project-delete"
  | "project-update"
  | "project-upload"
  | "project-download"
  | "project-process"
  | "project-cancel-process"
  | "project-load"           
  | "billing"
  | "upgrade"
  | "ai"
  | "account-profile"     
  | "account-password" 
  | "generic"
  | "assistant-suggest"
  | "project-reorder";


type ErrorInfo = {
  title: string;
  description: string;
};

export function getErrorMessage(
  context: ErrorContext,
  error?: unknown,
): ErrorInfo {
  // 1) Erros de rede (sem resposta)
  if (axios.isAxiosError(error) && !error.response) {
    return {
      title: "Connection unavailable",
      description:
        "Could not contact the server. Check your connection and try again.",
    };
  }

  // 2) Mensagem vinda do backend (string simples)
  const backendMsg =
    axios.isAxiosError(error) && typeof error.response?.data === "string"
      ? error.response?.data
      : undefined;

  // Exemplos de códigos / mensagens do backend que já vi no código
  if (backendMsg === "No more daily_operations available") {
    return {
      title: "Daily limit reached",
      description:
        "You have reached your daily limit for advanced operations. Try again tomorrow or upgrade to Premium.",
    };
  }

  // Ir acrescentando aqui outros códigos específicos do backend
  // if (backendMsg === "Invalid credentials") { ... }

  // 3) Contextos específicos
  switch (context) {
    case "auth-login":
      return {
        title: "Sign-in failed",
        description:
          backendMsg ??
          "Could not sign in. Check your credentials and try again.",
      };

    case "auth-register":
      return {
        title: "Registration failed",
        description:
          backendMsg ??
          "Could not complete registration. Check your details and try again.",
      };

    case "project-create":
      return {
        title: "Could not create project",
        description:
          backendMsg ??
          "Could not create the project. Check your connection and try again.",
      };

    case "project-upload":
      return {
        title: "Could not upload images",
        description:
          backendMsg ??
          "Images were not uploaded. Check the file formats and sizes and try again.",
      };

    case "project-download":
      return {
        title: "Download failed",
        description:
          backendMsg ??
          "Could not download the project. Please try again later.",
      };

    case "project-process":
      return {
        title: "Processing failed",
        description:
          backendMsg ??
          "Project processing failed. Please try again. If the problem persists, check your connection or try again later.",
      };

    case "project-cancel-process":
      return {
        title: "Could not cancel processing",
        description:
          backendMsg ??
          "Could not cancel processing. Check your connection and try again.",
      };

    case "account-profile":
      return {
        title: "Could not update profile",
        description:
          backendMsg ??
          "Could not update your profile. Check your details and try again.",
      };

    case "account-password":
      return {
        title: "Could not update password",
        description:
          backendMsg ??
          "Could not update your password. Check your current password and try again.",
      };


    case "upgrade":
      return {
        title: "Could not update plan",
        description:
          backendMsg ??
          "Could not change your subscription plan. Please try again.",
      };
    
    case "billing":
      return {
        title: "Billing error",
        description:
          backendMsg ??
          "Could not update your subscription or payment method. Check your details and try again.",
      };

    case "ai":
      return {
        title: "AI processing failed",
        description:
          backendMsg ??
          "Could not generate AI suggestions. Please try again. If the problem persists, check your connection.",
      };

    case "project-load":
      return {
        title: "Could not load project",
        description:
          backendMsg ??
          "Could not load the project. Check your connection and try again.",
      };

    case "assistant-suggest":
      return {
        title: "Processing failed",
        description: "Processing failed. Please try again.",

      };

    case "project-reorder":
      return {
        title: "Could not apply suggestion",
        description:
          backendMsg ??
          "Could not update the tool sequence. Please try again.",
      };

    default:
      return {
        title: "An error occurred",
        description:
          backendMsg ??
          "Something went wrong. Please try again now or later.",
      };
  }
}

// Códigos de erro que vêm das tools de IA (bg_remove_ai, cut_ai, upgrade_ai, obj_ai, people_ai, text_ai)
// Por agora podes ter mensagens genéricas e depois refinas se o prof pedir algo mais específico
export function getAiErrorMessage(
  code?: number,
  backendMsg?: string,
): ErrorInfo {
  if (code != null) {
    switch (code) {
      case 1100: // bg_remove_ai wrong_procedure
      case 1101: // bg_remove_ai error_processing
        return {
          title: "Background removal failed",
          description:
            "Could not remove the image background. Try again or choose another image.",
        };

      case 1800: // upgrade_ai wrong_procedure
      case 1801: // upgrade_ai error_processing
        return {
          title: "Image enhancement failed",
          description:
            "Could not enhance the image. Check its format and size and try again.",
        };

      case 2000: // cut_ai wrong_procedure
      case 2001: // cut_ai error_processing
        return {
          title: "Smart crop failed",
          description:
            "Could not calculate a smart crop. Try again or adjust the original image.",
        };

      case 2100: // obj_ai wrong_procedure
      case 2101: // obj_ai error_processing
        return {
          title: "Object detection failed",
          description:
            "Could not detect objects. Try again or use an image with more contrast.",
        };

      // Se tiveres códigos extra dos outros serviços (people_ai, text_ai), vais só acrescentando aqui.
    }
  }

  // fallback genérico
  return {
    title: "AI processing failed",
    description:
      backendMsg ??
      "Could not apply the AI tool. Please try again. If the problem persists, check your connection or try again later.",
  };
}
