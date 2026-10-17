// Clients & contracts client.
import { http } from './http'
import { useApi } from './query'
import type { Client, Contract } from '@/types/business'
import type { ClientDetail, ClientsResult } from '@/mock/routes/clients'
import type { FileInput } from './spend'

export type { ClientDetail, ClientRow, ClientsResult, ContractRow } from '@/mock/routes/clients'

export type ClientInput = Pick<Client, 'name' | 'industry' | 'country' | 'gstin' | 'billing_address' | 'primary_contact' | 'email' | 'phone' | 'owner_id' | 'payment_terms_days'> & { status?: Client['status']; notes?: string; city?: string; state?: string; state_code?: string; pincode?: string; pan?: string }
export type ContractInput = Pick<Contract, 'title' | 'kind' | 'value_paise' | 'start_on' | 'end_on' | 'renewal_on' | 'auto_renew' | 'project_id' | 'notes'> & { status?: Contract['status']; file?: FileInput | null }

export const clientsApi = {
  list: () => http.get<ClientsResult>('/clients'),
  get: (id: string) => http.get<ClientDetail>(`/clients/${id}`),
  lite: () => http.get<{ id: string; name: string }[]>('/clients-lite'),
  create: (b: ClientInput) => http.full<Client>('POST', '/clients', { body: b }),
  update: (id: string, b: Partial<ClientInput>, version?: number) => http.full<Client>('PATCH', `/clients/${id}`, { body: b, ifMatch: version }),
  addContract: (clientId: string, b: ContractInput) => http.full<Contract>('POST', `/clients/${clientId}/contracts`, { body: b }),
  updateContract: (id: string, b: Partial<ContractInput>, version?: number) => http.full<Contract>('PATCH', `/contracts/${id}`, { body: b, ifMatch: version }),
  renewContract: (id: string, b: { months: number; value_paise: number; notes?: string }) => http.full<Contract>('POST', `/contracts/${id}/renew`, { body: b }),
  deleteContract: (id: string, version?: number) => http.del(`/contracts/${id}`, version),
}
export const CLIENTS_INVALIDATE = [['clients'], ['client'], ['clients-lite'], ['spend-summary'], ['dash']]

export function useClients() {
  return useApi(['clients'], clientsApi.list)
}
export function useClient(id: string | undefined) {
  return useApi(['client', id], () => clientsApi.get(id!), { enabled: !!id })
}
export function useClientsLite(enabled = true) {
  return useApi(['clients-lite'], clientsApi.lite, { staleTime: 60_000, enabled })
}
