#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, Symbol};

#[contract]
pub struct DenylistGate;

#[contractimpl]
impl DenylistGate {
    pub fn add_to_denylist(env: Env, address: Address) {
        env.storage().instance().set(&address, &true);
        env.events()
            .publish((Symbol::new(&env, "denylist_added"),), address);
    }

    pub fn is_denylisted(env: Env, address: Address) -> bool {
        env.storage().instance().get(&address).unwrap_or(false)
    }
}
