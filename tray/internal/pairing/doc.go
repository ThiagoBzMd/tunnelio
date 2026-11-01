// Package pairing runs the device side (B) of the SPAKE2 pairing flow (SPEC §4): generates the
// 8-symbol secret, composes the code from the server-assigned claim, exchanges pake1/pake2/pake3
// through package relay, verifies cA, derives PK and pairing_id, and persists the pairing.
// One join per code; any failure invalidates the code.
package pairing
