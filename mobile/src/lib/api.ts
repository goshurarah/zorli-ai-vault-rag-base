import { getAuthHeaders as getBackendAuthHeaders } from './auth';
import { DocumentRecord, ChatMessage, AccountCredential, SubscriptionUsage, Payment } from '../types';

const API_URL = process.env.EXPO_PUBLIC_API_URL || '';

if (!API_URL) {
  console.warn('⚠️ API_URL is not configured. Please set EXPO_PUBLIC_API_URL in your .env file.');
}

interface ApiResponse<T = any> {
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
}

const getAuthHeaders = async (): Promise<HeadersInit> => {
  const authHeaders = await getBackendAuthHeaders();
  return {
    'Content-Type': 'application/json',
    ...authHeaders,
  };
};

export const getSignedUrl = async (storagePath: string): Promise<string | null> => {
  try {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_URL}/api/storage/signed-url`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ storagePath }),
    });
    const result = await response.json();
    return result.success && result.data?.signedUrl ? result.data.signedUrl : null;
  } catch (error) {
    console.error('Error getting signed URL:', error);
    return null;
  }
};

export const uploadFile = async (uri: string, filename: string, fileType: string): Promise<ApiResponse> => {
  const formData = new FormData();
  formData.append('files', {
    uri,
    name: filename,
    type: fileType,
  } as any);

  const authHeaders = await getBackendAuthHeaders();

  const response = await fetch(`${API_URL}/api/files/upload`, {
    method: 'POST',
    headers: { 
      ...authHeaders,
    },
    body: formData,
  });

  return response.json();
};

export const getFiles = async (): Promise<DocumentRecord[]> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/files`, {
    headers,
  });
  const result = await response.json();
  return result.success && Array.isArray(result.data) ? result.data : [];
};

export const deleteFile = async (fileId: string): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/files/${fileId}`, {
    method: 'DELETE',
    headers,
  });
  return response.json();
};

export const sendChatMessage = async (message: string, fileIds?: string[]): Promise<ApiResponse<{ message: string; content: string }>> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/ai/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, fileIds }),
  });
  return response.json();
};

export const getChatHistory = async (): Promise<ChatMessage[]> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/chat/messages`, {
    headers,
  });
  const result = await response.json();
  return result.success && Array.isArray(result.data) ? result.data : [];
};

export const saveChatMessage = async (message: ChatMessage): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/chat/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      role: message.role,
      content: message.content,
      files: message.files || null,
      timestamp: message.timestamp,
    }),
  });
  return response.json();
};

export const deleteChatHistory = async (): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/chat/messages`, {
    method: 'DELETE',
    headers,
  });
  return response.json();
};

export const getCredentials = async (): Promise<AccountCredential[]> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/credentials`, {
    headers,
  });
  const result = await response.json();
  return result.success && Array.isArray(result.data) ? result.data : [];
};

export const saveCredential = async (credential: Partial<AccountCredential>): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  
  // If credential has an ID, it's an update (PUT), otherwise it's a create (POST)
  const isUpdate = !!credential.id;
  const url = isUpdate 
    ? `${API_URL}/api/credentials/${credential.id}` 
    : `${API_URL}/api/credentials`;
  const method = isUpdate ? 'PUT' : 'POST';
  
  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(credential),
  });
  return response.json();
};

export const deleteCredential = async (credentialId: string): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/credentials/${credentialId}`, {
    method: 'DELETE',
    headers,
  });
  return response.json();
};

export const getSubscriptionStatus = async (): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/subscriptions/current`, {
    headers,
  });
  return response.json();
};

export const getSubscriptionUsage = async (): Promise<SubscriptionUsage> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/subscriptions/usage`, {
    headers,
  });
  const data = await response.json();
  return data.success ? data.data : { filesCount: 0, aiPromptsCount: 0, storageUsedBytes: 0 };
};

export const getDashboardStats = async (): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/dashboard/metrics`, {
    headers,
  });
  const data = await response.json();
  return data.success ? data.data : {};
};

export const updateProfile = async (data: { username?: string; profilePictureUrl?: string }): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/profile`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(data),
  });
  return response.json();
};

export const getPayments = async (): Promise<Payment[]> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/payments`, {
    headers,
  });
  const result = await response.json();
  return result.success && Array.isArray(result.data) ? result.data : [];
};

export const createCheckoutSession = async (stripePriceId: string, planName: string): Promise<ApiResponse<{ url: string }>> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/create-checkout-session`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ priceId: stripePriceId, planName, platform: 'mobile' }),
  });
  return response.json();
};

export const cancelSubscription = async (): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/subscriptions/cancel`, {
    method: 'POST',
    headers,
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to cancel subscription');
  }
  
  return response.json();
};

export const getAdminStats = async (): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/admin/stats`, {
    headers,
  });
  return response.json();
};

export const getAdminUsers = async (): Promise<any[]> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/admin/users`, {
    headers,
  });
  const result = await response.json();
  return result.success && Array.isArray(result.data) ? result.data : [];
};

export const getAdminSubscriptionStats = async (): Promise<any> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/admin/subscription-stats`, {
    headers,
  });
  const result = await response.json();
  return result.success ? result.data : {};
};

export const getAdminUsageStats = async (): Promise<any> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/admin/usage-stats`, {
    headers,
  });
  const result = await response.json();
  return result.success ? result.data : {};
};

export const getAdminPayments = async (): Promise<any[]> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/admin/payments`, {
    headers,
  });
  const result = await response.json();
  return result.success && Array.isArray(result.data) ? result.data : [];
};

export const uploadProfilePicture = async (uri: string): Promise<ApiResponse> => {
  const formData = new FormData();
  
  // Extract filename from URI
  const filename = uri.split('/').pop() || 'profile.jpg';
  
  // Determine MIME type from file extension
  let mimeType = 'image/jpeg';
  const extension = filename.split('.').pop()?.toLowerCase();
  
  if (extension === 'png') {
    mimeType = 'image/png';
  } else if (extension === 'gif') {
    mimeType = 'image/gif';
  } else if (extension === 'webp') {
    mimeType = 'image/webp';
  }
  
  formData.append('profilePicture', {
    uri,
    name: filename,
    type: mimeType,
  } as any);

  const authHeaders = await getBackendAuthHeaders();

  const response = await fetch(`${API_URL}/api/user/profile-picture`, {
    method: 'POST',
    headers: {
      ...authHeaders,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to upload profile picture');
  }

  return response.json();
};

export const updateUsername = async (username: string): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/user/username`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ username }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update username');
  }

  return response.json();
};

export const removeProfilePicture = async (): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/user/profile-picture`, {
    method: 'DELETE',
    headers,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to remove profile picture');
  }

  return response.json();
};

export const deleteUser = async (userId: string): Promise<ApiResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/api/admin/users/${userId}`, {
    method: 'DELETE',
    headers,
  });
  return response.json();
};
