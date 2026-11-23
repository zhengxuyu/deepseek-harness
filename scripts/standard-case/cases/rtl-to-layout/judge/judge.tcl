# Read a finished layout and print the facts the case judges, one `JUDGE <key> <value>` line each.
# Inputs come from the environment: JUDGE_ODB, JUDGE_LIB, JUDGE_SDC, JUDGE_RC.
# The netlist of the layout is written to JUDGE_NETLIST, for the gate-level simulation of what was routed.
read_liberty $::env(JUDGE_LIB)
read_db $::env(JUDGE_ODB)
set block [ord::get_db_block]
puts "JUDGE top [$block getName]"
write_verilog $::env(JUDGE_NETLIST)

set instances [$block getInsts]
set unplaced 0
foreach instance $instances {
  if { ![$instance isPlaced] } { incr unplaced }
}
puts "JUDGE instances [llength $instances]"
puts "JUDGE unplaced $unplaced"

set signal_nets 0
set unrouted 0
foreach net [$block getNets] {
  if { [$net isSpecial] } { continue }
  if { [llength [$net getITerms]] + [llength [$net getBTerms]] < 2 } { continue }
  incr signal_nets
  if { [$net getWire] eq "NULL" } { incr unrouted }
}
puts "JUDGE signal_nets $signal_nets"
puts "JUDGE unrouted $unrouted"

if { [catch { check_placement } message] } {
  puts "JUDGE placement_legal 0"
} else {
  puts "JUDGE placement_legal 1"
}

read_sdc $::env(JUDGE_SDC)
source $::env(JUDGE_RC)
set_propagated_clock [all_clocks]
estimate_parasitics -placement
puts "JUDGE worst_slack_ns [sta::worst_slack -max]"
