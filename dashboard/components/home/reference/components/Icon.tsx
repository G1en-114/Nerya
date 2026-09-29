/* Adapted from the companion NeryaAI website. */
/* eslint-disable @next/next/no-img-element */
import React from 'react';
import paths from '../data/icon-paths.json';
export default function Icon({name='arrowUpRight',size=20,className=''}:{name?:string;size?:number;className?:string}){
  const d=(paths as Record<string,string>)[name];
  if(!d)throw new Error(`Unknown Nerya icon: ${name}`);
  return <svg className={`nerya-icon ${className}`} data-nerya-icon={name} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={d}/></svg>;
}
