import { expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { createTotp, hashRecoveryCode } from '../../server/totp.js';
import { validateTestDatabaseUrl } from '../postgres.js';

async function recovery(email:string){
 const url=process.env.FACET_E2E_DATABASE_URL!;validateTestDatabaseUrl(url);
 const pool=new Pool({connectionString:url});
 try{
  const id=email==='admin@facet.test'?'admin':(await pool.query('SELECT id FROM users WHERE email=$1',[email])).rows[0].id;
  const code=randomBytes(12).toString('hex');
  await pool.query('UPDATE mfa_factors SET recovery_hashes=recovery_hashes || $1::jsonb WHERE account_id=$2',[JSON.stringify([hashRecoveryCode(code)]),id]);
  return code;
 }finally{await pool.end();}
}
export async function apiLogin(request:APIRequestContext, options:{data:{email:string;password:string;newPassword?:string}}):Promise<APIResponse>{
 let response=await request.post('/api/auth/login',options);
 if(response.status()!==200)return response;
 let result=await response.json();
 if(result.mfaEnrollmentRequired){
  const confirmed=await request.post('/api/auth/mfa/enrollment/confirm',{data:{enrollmentToken:result.enrollmentToken,code:createTotp(result.secret,'Fixture').generate()}});expect(confirmed.status()).toBe(200);
  response=await request.post('/api/auth/login',options);result=await response.json();
 }
 if(result.mfaRequired)return request.post('/api/auth/mfa/verify',{data:{challengeToken:result.challengeToken,code:await recovery(options.data.email)}});
 return response;
}
export async function completeSecondFactor(page:Page,email:string){
 await expect(page.getByLabel('Código de verificação',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Usar código de recuperação',exact:true}).click();
 await page.getByLabel('Código de recuperação',{exact:true}).fill(await recovery(email));
 await page.getByRole('button',{name:'Verificar e entrar',exact:true}).click();
}
export async function submitLogin(page:Page){
 const email=await page.getByLabel('E-mail',{exact:true}).inputValue();
 const password=await page.getByLabel('Senha',{exact:true}).inputValue();
 const response=page.waitForResponse(response=>response.url().endsWith('/api/auth/login')&&response.request().method()==='POST');
 await page.getByRole('button',{name:'Entrar',exact:true}).click();
 const actual=await response;
 if(actual.status()!==200)return;
 const result=await actual.json();
 if(result.mfaEnrollmentRequired){
  await page.getByLabel('Código do aplicativo',{exact:true}).fill(createTotp(result.secret,'Fixture').generate());
  await page.getByRole('button',{name:'Confirmar autenticador e ativar',exact:true}).click();
  await page.getByRole('button',{name:'Guardei os códigos',exact:true}).click();
  await page.getByLabel('E-mail',{exact:true}).fill(email);await page.getByLabel('Senha',{exact:true}).fill(password);await submitLogin(page);
 }else if(result.mfaRequired)await completeSecondFactor(page,email);
}
export async function submitInvitation(page:Page){
 const response=page.waitForResponse(response=>response.url().endsWith('/api/invitations/accept')&&response.request().method()==='POST');
 await page.getByRole('button',{name:'Continuar para o autenticador',exact:true}).click();
 const enrollment=await (await response).json();
 await page.getByLabel('Código do aplicativo',{exact:true}).fill(createTotp(enrollment.secret,'Fixture').generate());
 await page.getByRole('button',{name:'Confirmar autenticador e ativar',exact:true}).click();
 await page.getByRole('button',{name:'Guardei os códigos',exact:true}).click();
}
