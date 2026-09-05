from base64 import b64decode, b64encode
import hashlib, argparse

def rc4mi(data, key):
    S, j, out = bytearray(range(256)), 0, bytearray()

    for i in range(256):
        j = (j + key[i % len(key)] + S[i]) % 256
        S[i], S[j] = S[j], S[i]

    # 1024 fake rounds
    i = j = 0
    for x in range(1024):
        i = (i + 1) % 256
        j = (j + S[i]) % 256
        S[i], S[j] = S[j], S[i]

    for ch in data:
        i = (i + 1) % 256
        j = (j + S[i]) % 256
        S[i], S[j] = S[j], S[i]
        out.append(ch ^ S[(S[i] + S[j]) % 256])

    return out

def create_key(ssecurity, nonce):
    return b64encode(hashlib.sha256(b64decode(ssecurity) + b64decode(nonce)).digest()).decode()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Cipher and Decipher MiHome RC4 messages')

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--cipher', action='store_true')
    group.add_argument('--decipher', action='store_true')
    
    parser.add_argument('-s', "--ssecurity", dest="ssecurity", required=True, help="ssecurity parameter")
    parser.add_argument('-n', "--nonce", dest="nonce", required=True, help="nonce parameter")

    parser.add_argument('-m', "--message", dest="message", required=True, help="message content")

    args = parser.parse_args()

    key = create_key(args.ssecurity, args.nonce)
    print("KEY: {}".format(key))

    if args.cipher:
        result = b64encode(rc4mi(args.message.encode('utf-8'), b64decode(key)))
        print("CIPHERTEXT: {}".format(result))
    else:
        result = rc4mi(b64decode(args.message), b64decode(key)).decode('utf-8')
        print("CLEARTEXT: {}".format(result))
