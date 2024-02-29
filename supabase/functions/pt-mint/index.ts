import { generateNonce as getNonce } from 'siwe'
import { corsHeaders } from '../_shared/cors.ts'
import { supabaseAdmin } from '../_shared/supabaseAdmin.ts'
import { isAddress } from '@ethersproject/address'
import { ethers } from 'ethers'

function validateAmount(amount: string): boolean {
  const regex = /^(?!0\d|$)\d+(\.\d{1,18})?$/
  if (!regex.test(amount)) {
    return false
  }
  const numericAmount = parseFloat(amount)
  return numericAmount >= 10
}

const contractAddress = '0xAD32172b6B8860d3015FAeAbF289823453201568'
const contractABI = ['function mint(address to, uint256 amount)']

async function mintPoints(to: string, amount: string) {
  const provider = new ethers.JsonRpcProvider(Deno.env.get('ETHEREUM_RPC_URL'))
  const signer = new ethers.Wallet(Deno.env.get('PRIVATE_KEY')!)

  const contract = new ethers.Contract(
    contractAddress,
    contractABI,
    signer.connect(provider)
  )

  const amountInWei = ethers.parseUnits(amount, 21)
  const tx = await contract.mint(to, amountInWei)
  const receipt = await tx.wait() // Wait for the transaction to be mined

  if (receipt.status === 1) {
    console.log('Transaction successful')
  } else {
    console.error('Transaction failed')
    throw new Error('Transaction failed')
  }
}

// TODO: separate this function as a on-chain mint event monitor
// create a new mint record with status "pending" and update it after mint event success
// freeze first, then update database after mint event sucess
async function updateDatabaseAfterMint(
  publisherName: string,
  ownerAddress: string,
  amount: string
): Promise<void> {
  const numericAmount = parseFloat(amount)

  // update final statistic
  const { error } = await supabaseAdmin.rpc('updatedatabaseaftermintpoints', {
    publisher_name_arg: publisherName,
    owner_address_arg: ownerAddress,
    amount_arg: numericAmount,
  })
  if (error) {
    throw new Error(error.message)
  }
}

interface MessageObjType {
  address: string
  publisherName: string
  amount: string
  nonce: string
}

function checkRequest(messageObj: MessageObjType, signature: string): void {
  if (!messageObj || !signature) throw new Error('missing params')

  if (!isAddress(messageObj.address)) {
    throw new Error('Invalid public address')
  }

  if (!messageObj.publisherName) {
    throw new Error('Invalid publisher name')
  }

  // Check that amout is greater than 10 and has at most 18 digits after the decimal point
  if (!validateAmount(messageObj.amount)) {
    throw new Error('Invalid amount')
  }
}

async function checkDeviceStatus(publisherName: string) {
  const { data, error } = await supabaseAdmin
    .from('device_info')
    .select('id, initialized')
    .eq('publisher_name', publisherName)

  if (error) {
    throw new Error(error.message)
  }

  if (data.length == 0) {
    throw new Error('Device does not exist')
  }

  if (!data[0].initialized) {
    throw new Error('Device not initialized')
  }
}

async function checkDeviceBinding(ownerAddress: string, publisherName: string) {
  const { data, error } = await supabaseAdmin
    .from('device_binding')
    .select('id')
    .eq('owner_address', ownerAddress)
    .eq('publisher_name', publisherName)

  if (error) {
    throw new Error(error.message)
  }

  if (data.length == 0) {
    throw new Error('Device not bound')
  }
}

async function checkSignature(
  messageObj: MessageObjType,
  signature: string
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('t_nonces')
    .select('public_address, nonce')
    .eq('public_address', messageObj.address)

  if (error) {
    throw new Error(error.message)
  }

  if (data.length == 0) {
    throw new Error('Nonce does not exist')
  }
  const { nonce } = data[0]
  if (nonce !== messageObj.nonce) {
    throw new Error('Invalid nonce')
  }

  const signerAddr = ethers.verifyMessage(JSON.stringify(messageObj), signature)
  if (signerAddr !== messageObj.address) {
    throw new Error('Invalid signature')
  }
}

async function updateNonce(address: string, newNonce: string) {
  const { error } = await supabaseAdmin
    .from('t_nonces')
    .update({ nonce: newNonce })
    .eq('public_address', address)

  if (error) {
    throw new Error(error.message)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { message: messageObj, signature } = await req.json()

    checkRequest(messageObj, signature)

    await checkDeviceStatus(messageObj.publisherName)

    // check table device_binding for existing record
    await checkDeviceBinding(messageObj.address, messageObj.publisherName)

    await checkSignature(messageObj, signature)

    const newNonce = getNonce()
    await updateNonce(messageObj.address, newNonce)

    await mintPoints(messageObj.address, messageObj.amount)

    await updateDatabaseAfterMint(
      messageObj.publisherName,
      messageObj.address,
      messageObj.amount
    )

    return new Response(JSON.stringify({}), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    console.log(error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})