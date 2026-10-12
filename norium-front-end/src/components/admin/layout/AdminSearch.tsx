import {createContext,useContext} from 'react';

export const AdminSearchContext=createContext('');
export function useAdminSearch(){return useContext(AdminSearchContext);}
export function matchesAdminSearch(query:string,...values:unknown[]){
  const normalize=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR');
  const needle=normalize(query.trim());
  if(!needle)return true;
  return normalize(values.map(value=>typeof value==='string'?value:JSON.stringify(value)??'').join(' ')).includes(needle);
}
