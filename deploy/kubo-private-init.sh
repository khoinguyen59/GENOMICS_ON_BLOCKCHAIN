#!/bin/sh
set -eu

# GenoChain Protocol - Private Kubo Network Isolation Hook
# Mounted read-only at /container-init.d/001-private-network.sh in ipfs/kubo:v0.32.1
# Automatically executed by Kubo's container_daemon entrypoint BEFORE starting the IPFS daemon.
# Disables public Amino DHT bootstrap, mDNS LAN discovery, Circuit Relay, and AutoNAT dialing
# so encrypted genomic ciphertexts can never be announced or routed to the public IPFS network.

ipfs bootstrap rm --all
ipfs config Routing.Type none
ipfs config --json Discovery.MDNS.Enabled false
ipfs config --json Swarm.RelayClient.Enabled false
ipfs config --json Swarm.RelayService.Enabled false
ipfs config --json AutoNAT.ServiceMode '"disabled"'